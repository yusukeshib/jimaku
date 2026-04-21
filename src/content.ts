import { applyHideOriginal, setOverlayText, updateOverlayPosition } from "./content/overlay";
import { watchForPlayback, watchForVideo } from "./content/playback";
import { state } from "./content/state";
import { createTrackResolver } from "./content/trackResolver";
import {
  applySubtitleUrl,
  attachVideoSync,
  onEnabledChanged,
  onPlaybackChange,
  onTargetLanguageChanged,
  onVideoFound,
} from "./content/translation";
import {
  DEFAULT_TARGET_LANGUAGE,
  getEnabled,
  getHideOriginal,
  getShowTranslated,
  getTargetLanguage,
} from "./lib/cache";
import type { ContentReady, ExtensionMessage, StateSnapshot, StateUpdate } from "./types";

// ---------- Snapshot + broadcast ----------

function findTitle(): string | null {
  const sels = [".atvwebplayersdk-title-text", '[class*="TitleContainer"] [class*="title"]', "h1"];
  for (const sel of sels) {
    const el = document.querySelector(sel) as HTMLElement | null;
    const t = el?.textContent?.trim();
    if (t) return t;
  }
  const t = document.title
    ?.replace(/\s*\|\s*Prime Video\s*$/i, "")
    .replace(/^Watch\s+/i, "")
    .trim();
  return t || null;
}

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
    title: findTitle(),
  };
}

function broadcastState() {
  const msg: StateUpdate = { type: "STATE_UPDATE", state: snapshot() };
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ---------- Overlay subscriber (pure derivation from state) ----------

function paintOverlay() {
  const v = state.video;
  if (!state.showTranslated || !v) {
    setOverlayText("");
  } else {
    const cue = state.cues.findAt(v.currentTime - state.timeOffset);
    setOverlayText(cue ? cue.text : "");
  }
  applyHideOriginal(state.hideOriginal);
  updateOverlayPosition({ video: state.video, hideOriginal: state.hideOriginal });
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
      state.onTabReset();
      break;
    case "POPUP_GET_STATE":
      broadcastState();
      break;
  }
});

// ---------- Bootstrap ----------

void (async () => {
  const [showTranslated, hideOriginal, targetLanguage, enabled] = await Promise.all([
    getShowTranslated(),
    getHideOriginal(),
    getTargetLanguage(),
    getEnabled(),
  ]);
  state.setShowTranslated(showTranslated);
  state.setHideOriginal(hideOriginal);
  state.setTargetLanguage(targetLanguage);
  state.setEnabled(enabled);

  // Subscribe after bootstrap so a single initial notify covers both.
  state.subscribe(broadcastState);
  state.subscribe(paintOverlay);
  paintOverlay();
  broadcastState();

  const readyMsg: ContentReady = { type: "CONTENT_READY" };
  chrome.runtime.sendMessage(readyMsg).catch(() => {});
})();

// ---------- Storage settings ----------

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
});

// ---------- DOM lifecycle ----------

watchForVideo((video) => {
  onVideoFound(video);
  if (video !== state.video) attachVideoSync(video);
});
watchForPlayback(onPlaybackChange);

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
