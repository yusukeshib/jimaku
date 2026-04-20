import { applyHideOriginal, updateOverlayPosition } from "./content/overlay";
import { watchForPlayback, watchForVideo } from "./content/playback";
import { state } from "./content/state";
import { createTrackResolver } from "./content/trackResolver";
import {
  applySubtitleUrl,
  configureTranslation,
  onEnabledChanged,
  onPlaybackChange,
  onTargetLanguageChanged,
  onVideoFound,
  repaintOverlay,
  resetForTabReset,
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
  // Prefer explicit player-chrome titles; fall back to the document heading
  // and then to <title>, stripping Amazon's wrapper text.
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
    status: state.status,
    progress: state.progress,
    error: state.error,
    hasSubtitle: state.subtitleUrl !== null,
    enabled: state.enabled,
    title: findTitle(),
  };
}

function broadcastState() {
  const msg: StateUpdate = { type: "STATE_UPDATE", state: snapshot() };
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ---------- Wiring ----------

configureTranslation({
  broadcast: broadcastState,
  getPosContext: () => ({ video: state.video, hideOriginal: state.hideOriginal }),
});

const trackResolver = createTrackResolver({
  getCurrentUrl: () => state.subtitleUrl,
  onResolved: (url) => void applySubtitleUrl(url),
});

// ---------- Overlay lifecycle ----------

function reapplyOverlayChrome() {
  applyHideOriginal(state.hideOriginal);
  updateOverlayPosition({ video: state.video, hideOriginal: state.hideOriginal });
}

// ---------- chrome.runtime messaging ----------

chrome.runtime.onMessage.addListener((raw: ExtensionMessage) => {
  switch (raw.type) {
    case "SUBTITLE_DETECTED":
      trackResolver.add(raw.url);
      break;
    case "TAB_RESET":
      trackResolver.clear();
      resetForTabReset();
      break;
    case "POPUP_GET_STATE":
      broadcastState();
      break;
  }
});

// ---------- Bootstrap ----------

// Load all settings before announcing readiness so message handlers don't
// act on default values (e.g. auto-start when the user has enabled=false).
void (async () => {
  const [showTranslated, hideOriginal, targetLanguage, enabled] = await Promise.all([
    getShowTranslated(),
    getHideOriginal(),
    getTargetLanguage(),
    getEnabled(),
  ]);
  state.showTranslated = showTranslated;
  state.hideOriginal = hideOriginal;
  state.targetLanguage = targetLanguage;
  state.enabled = enabled;
  reapplyOverlayChrome();
  repaintOverlay();
  const readyMsg: ContentReady = { type: "CONTENT_READY" };
  chrome.runtime.sendMessage(readyMsg).catch(() => {});
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.showTranslated) {
    state.showTranslated = changes.showTranslated.newValue !== false;
    repaintOverlay();
  }
  if (changes.hideOriginal) {
    state.hideOriginal = changes.hideOriginal.newValue === true;
    reapplyOverlayChrome();
  }
  if (changes.targetLanguage) {
    const v = changes.targetLanguage.newValue;
    state.targetLanguage = typeof v === "string" && v.trim() ? v : DEFAULT_TARGET_LANGUAGE;
    void onTargetLanguageChanged();
  }
  if (changes.enabled) {
    onEnabledChanged(changes.enabled.newValue !== false);
  }
});

// ---------- DOM lifecycle ----------

watchForVideo(onVideoFound);
watchForPlayback(onPlaybackChange);

window.addEventListener("resize", () =>
  updateOverlayPosition({ video: state.video, hideOriginal: state.hideOriginal }),
);
document.addEventListener("fullscreenchange", () =>
  updateOverlayPosition({ video: state.video, hideOriginal: state.hideOriginal }),
);
// When the page is going away (tab close, navigation), abort any in-flight
// translation so the fetch is cancelled and the partial cache write we did
// during streaming is what the next visit picks up.
window.addEventListener("pagehide", () => {
  state.abortCtrl?.abort();
});
