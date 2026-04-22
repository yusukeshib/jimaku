import { attachCalibration } from "./content/calibration";
import { applyHideOriginal, setOverlayText, updateOverlayPosition } from "./content/overlay";
import { findVideo, watchForPlayback, watchForVideo } from "./content/playback";
import { state } from "./content/state";
import { resetSubtitleHint, updateSubtitleHint } from "./content/subtitleHint";
import { createTrackResolver } from "./content/trackResolver";
import {
  applySubtitleUrl,
  cancelProvidedSubtitles,
  onEnabledChanged,
  onPlaybackTransition,
  onProviderReadyChanged,
  onTargetLanguageChanged,
} from "./content/translation";
import {
  DEFAULT_TARGET_LANGUAGE,
  getEnabled,
  getHideOriginal,
  getProvider,
  getProviderKey,
  getShowTranslated,
  getTargetLanguage,
} from "./lib/cache";
import type { ProviderId } from "./lib/providers";
import { currentPlatform } from "./platforms";
import type { ContentReady, ExtensionMessage, StateSnapshot, StateUpdate } from "./types";

// ---------- Snapshot + broadcast ----------

function snapshot(): StateSnapshot {
  return {
    translation: {
      phase: state.phase,
      progress: state.progress,
      error: state.error,
    },
    playback: state.playback,
    hasSubtitle: state.subtitleUrl !== null,
    enabled: state.enabled,
    providerReady: state.providerReady,
    title: currentPlatform()?.findTitle() ?? null,
  };
}

function broadcastState() {
  const msg: StateUpdate = { type: "STATE_UPDATE", state: snapshot() };
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ---------- Overlay subscriber (pure derivation from state) ----------

function paintOverlay() {
  // Invariant: state.video is non-null iff playback is playing/paused.
  // So checking state.video alone is sufficient.
  const v = state.video;
  if (!state.showTranslated || !v) {
    setOverlayText("");
  } else {
    const cue = state.cues.findAt(v.currentTime - state.timeOffset);
    setOverlayText(cue ? cue.text : "");
  }
  applyHideOriginal(state.hideOriginal && v !== null);
  updateOverlayPosition({ video: v, hideOriginal: state.hideOriginal });
}

// --- Video binding sync: single owner of state.video ---

function syncVideoBinding() {
  const want = findVideo();
  if (want === state.video) return;
  if (state.video) state.onVideoDetached();
  if (want) state.onVideoAttached(want, attachCalibration(want));
}

// ---------- Track resolver ----------

const trackResolver = createTrackResolver({
  getCurrentUrl: () => state.subtitleUrl,
  onResolved: (url) => void applySubtitleUrl(url),
});

// ---------- chrome.runtime messaging ----------

chrome.runtime.onMessage.addListener((raw: ExtensionMessage) => {
  switch (raw.type) {
    case "SUBTITLE_DETECTED":
      trackResolver.add(raw.url);
      break;
    case "TAB_RESET":
      trackResolver.clear();
      cancelProvidedSubtitles();
      state.onTabReset();
      resetSubtitleHint();
      break;
    case "POPUP_GET_STATE":
      broadcastState();
      break;
  }
});

// ---------- Bootstrap ----------

async function readProviderReady(): Promise<boolean> {
  const id = await getProvider();
  const key = await getProviderKey(id);
  return key !== null;
}

void (async () => {
  const [showTranslated, hideOriginal, targetLanguage, enabled, providerReady] = await Promise.all([
    getShowTranslated(),
    getHideOriginal(),
    getTargetLanguage(),
    getEnabled(),
    readProviderReady(),
  ]);
  state.setShowTranslated(showTranslated);
  state.setHideOriginal(hideOriginal);
  state.setTargetLanguage(targetLanguage);
  state.setEnabled(enabled);
  state.setProviderReady(providerReady);

  // Subscribe after bootstrap so a single initial notify covers both.
  state.subscribe(broadcastState);
  state.subscribe(paintOverlay);
  state.subscribe(updateSubtitleHint);
  paintOverlay();
  broadcastState();
  updateSubtitleHint();

  const readyMsg: ContentReady = { type: "CONTENT_READY" };
  chrome.runtime.sendMessage(readyMsg).catch(() => {});
})();

// ---------- Storage settings ----------

const PROVIDER_KEY_STORAGE: Record<ProviderId, string> = {
  anthropic: "anthropicKey",
  openai: "openaiKey",
  openrouter: "openrouterKey",
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.showTranslated) state.setShowTranslated(changes.showTranslated.newValue !== false);
  if (changes.hideOriginal) state.setHideOriginal(changes.hideOriginal.newValue === true);
  if (changes.targetLanguage) {
    const v = changes.targetLanguage.newValue;
    state.setTargetLanguage(typeof v === "string" && v.trim() ? v : DEFAULT_TARGET_LANGUAGE);
    void onTargetLanguageChanged();
  }
  if (changes.enabled) onEnabledChanged(changes.enabled.newValue !== false);

  // Provider selection or any of the per-provider keys may affect readiness.
  // Re-derive from storage rather than inferring from the diff — simpler and
  // always correct.
  const providerTouched =
    changes.provider !== undefined ||
    Object.values(PROVIDER_KEY_STORAGE).some((k) => changes[k] !== undefined);
  if (providerTouched) {
    void readProviderReady().then((ready) => {
      const prev = state.providerReady;
      state.setProviderReady(ready);
      if (ready && !prev) onProviderReadyChanged();
    });
  }
});

// ---------- DOM lifecycle ----------

// Re-evaluate video binding whenever the DOM changes (video remount) or
// playback state transitions (player opened/closed). Both feed into the
// single sync function that owns state.video.
watchForVideo(syncVideoBinding);
watchForPlayback((next) => {
  state.onPlaybackChanged(next);
  syncVideoBinding();
  onPlaybackTransition(next);
});

// Video clock drives re-paint (time-driven re-derive, not a state change).
// We listen inside a MutationObserver-style pattern: re-attach whenever the
// tracked video element changes. Simpler: check on every paint — if the video
// changed since last listen, rebind.
let boundVideo: HTMLVideoElement | null = null;
function rebindTimeupdate() {
  if (state.video === boundVideo) return;
  if (boundVideo) boundVideo.removeEventListener("timeupdate", paintOverlay);
  boundVideo = state.video;
  if (boundVideo) boundVideo.addEventListener("timeupdate", paintOverlay);
}
state.subscribe(rebindTimeupdate);

window.addEventListener("resize", () =>
  updateOverlayPosition({ video: state.video, hideOriginal: state.hideOriginal }),
);
document.addEventListener("fullscreenchange", () =>
  updateOverlayPosition({ video: state.video, hideOriginal: state.hideOriginal }),
);
// Tab closing — abort in-flight so streaming doesn't continue after unmount.
window.addEventListener("pagehide", () => {
  state.abortCtrl?.abort();
});
