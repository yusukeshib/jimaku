import { normalizeCueText } from "./content/cueList";
import {
  applyHideOriginal as applyHideOriginalImpl,
  nativeCaptionEl,
  setOverlayText,
  updateOverlayPosition as updateOverlayPositionImpl,
} from "./content/overlay";
import { state } from "./content/state";
import {
  DEFAULT_TARGET_LANGUAGE,
  getApiKey,
  getCache,
  getEnabled,
  getHideOriginal,
  getShowTranslated,
  getTargetLanguage,
  setCache,
} from "./lib/cache";
import { loadCues } from "./lib/subtitle";
import { AbortError, MODEL, translateCues } from "./lib/translate";
import type {
  ContentReady,
  Cue,
  ExtensionMessage,
  StateSnapshot,
  StateUpdate,
  TranslatedCue,
} from "./types";

// State lives in ./content/state; overlay DOM in ./content/overlay.

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

function findVideo(): HTMLVideoElement | null {
  const videos = Array.from(document.querySelectorAll("video")).filter(
    (v) => v.videoWidth > 0 && v.videoHeight > 0,
  );
  if (videos.length === 0) return null;
  // Prime Video keeps a paused preroll ad <video> and the playing main <video>
  // simultaneously; prefer the one that is actually playing, then the longest.
  const playing = videos.filter((v) => !v.paused);
  const pool = playing.length > 0 ? playing : videos;
  return pool.reduce((best, v) => (v.duration > (best?.duration ?? 0) ? v : best), pool[0]);
}

function positionContext() {
  return { video: state.video ?? findVideo(), hideOriginal: state.hideOriginal };
}

function updateOverlayPosition() {
  updateOverlayPositionImpl(positionContext());
}

function repaintOverlay() {
  if (!state.showTranslated) {
    setOverlayText("");
    return;
  }
  const v = state.video;
  if (!v) return;
  const cue = findCueAt(v.currentTime - state.timeOffset);
  setOverlayText(cue ? cue.text : "");
  updateOverlayPosition();
}

function applyHideOriginal() {
  applyHideOriginalImpl(state.hideOriginal);
  updateOverlayPosition();
}

// Cue storage + search lives in ./content/cueList (CueList, SourceCueIndex).
// Thin wrappers keep the existing call sites short.
const findCueAt = (seconds: number) => state.cues.findAt(seconds);
const setCues = (cues: TranslatedCue[]) => state.cues.set(cues);
const appendStreamingCue = (cue: TranslatedCue) => state.cues.append(cue);
const setSourceCues = (cues: Cue[]) => state.sourceIndex.set(cues);

function attachCalibration(video: HTMLVideoElement) {
  state.cleanupCalibration?.();

  let lastSeenText = "";
  const tryCalibrate = () => {
    if (state.sourceIndex.size === 0) return;
    const el = nativeCaptionEl();
    const raw = el?.textContent ?? "";
    if (raw === lastSeenText) return;
    lastSeenText = raw;
    const key = normalizeCueText(raw);
    if (!key) return;
    const matches = state.sourceIndex.lookupByText(key);
    if (!matches || matches.length === 0) return;
    // Pick the cue whose start is closest to (currentTime - currentOffset).
    // On first calibration offset is 0 so we fall back to raw currentTime;
    // that's OK because the cue we see in the DOM is the one Prime Video
    // has rendered for "now".
    const t = video.currentTime;
    const target = t - state.timeOffset;
    const best = matches.reduce((b, c) =>
      Math.abs(c.start - target) < Math.abs(b.start - target) ? c : b,
    );
    const newOffset = t - best.start;
    if (Math.abs(newOffset - state.timeOffset) < 0.05) return;
    state.timeOffset = newOffset;
    if (state.showTranslated) {
      const cue = findCueAt(video.currentTime - state.timeOffset);
      setOverlayText(cue ? cue.text : "");
      updateOverlayPosition();
    }
  };

  // Scope narrowly when possible: observing the whole body subtree with
  // characterData generates far more noise than we need.
  let textObserver: MutationObserver | null = null;
  let scoped: Element | null = null;
  const scopeTo = (el: Element) => {
    if (scoped === el) return;
    textObserver?.disconnect();
    scoped = el;
    textObserver = new MutationObserver(tryCalibrate);
    textObserver.observe(el, { childList: true, subtree: true, characterData: true });
    tryCalibrate();
  };

  const existing = document.querySelector(".atvwebplayersdk-captions-text");
  if (existing) scopeTo(existing);

  // The caption element can be (re)mounted by the player; watch for it.
  const discoverObserver = new MutationObserver(() => {
    const el = document.querySelector(".atvwebplayersdk-captions-text");
    if (el && el !== scoped) scopeTo(el);
  });
  discoverObserver.observe(document.body ?? document.documentElement, {
    childList: true,
    subtree: true,
  });

  state.cleanupCalibration = () => {
    textObserver?.disconnect();
    discoverObserver.disconnect();
    state.cleanupCalibration = null;
  };
}

function attachVideoSync(video: HTMLVideoElement) {
  if (state.video === video) return;
  state.cleanupVideo?.();
  state.video = video;
  const onUpdate = () => {
    if (!state.showTranslated) {
      setOverlayText("");
      return;
    }
    const cue = findCueAt(video.currentTime - state.timeOffset);
    setOverlayText(cue ? cue.text : "");
    updateOverlayPosition();
  };
  video.addEventListener("timeupdate", onUpdate);
  state.cleanupVideo = () => {
    video.removeEventListener("timeupdate", onUpdate);
    state.video = null;
    state.cleanupVideo = null;
  };
  attachCalibration(video);
}

async function runTranslation(resumeFrom: TranslatedCue[] | null) {
  if (!state.enabled || !state.subtitleUrl) return;
  // Guard on the abort controller, not on status. Status can lag (e.g. an
  // aborted prior run's `finally` hasn't executed yet) which would wrongly
  // block a freshly-kicked translation.
  if (state.abortCtrl !== null) return;

  const apiKey = await getApiKey();
  if (!apiKey) {
    state.error = "No API key set. Open the extension options to add one.";
    state.transition("error", "missing api key");
    broadcastState();
    return;
  }

  state.error = null;
  state.transition("translating", "runTranslation start");
  const ctrl = new AbortController();
  state.abortCtrl = ctrl;
  const { signal } = ctrl;

  const targetUrl = state.subtitleUrl;
  const targetLang = state.targetLanguage;
  const stillCurrent = () =>
    state.enabled && state.subtitleUrl === targetUrl && state.targetLanguage === targetLang;

  try {
    let cues: Cue[];
    if (state.sourceIndex.size > 0) {
      cues = state.sourceIndex.cues;
    } else {
      const text = await fetchSubtitleText(targetUrl, signal);
      cues = await loadCues(targetUrl, text, fetchSubtitleText, signal);
      if (cues.length === 0) throw new Error("Subtitle parse produced no cues");
      setSourceCues(cues);
    }

    // Seed or trust existing cue state for incremental rendering.
    if (resumeFrom && resumeFrom.length > 0) {
      setCues(resumeFrom);
    } else {
      state.cues.clear();
    }
    state.progress = { done: resumeFrom?.length ?? 0, total: cues.length };
    broadcastState();

    const earlyVideo = findVideo();
    if (earlyVideo) attachVideoSync(earlyVideo);

    let lastCacheWrite = 0;
    const CACHE_WRITE_INTERVAL_MS = 2000;

    const translated = await translateCues(cues, apiKey, {
      signal,
      targetLanguage: targetLang,
      resumeFrom: resumeFrom ?? undefined,
      onProgress: (done, total) => {
        if (!stillCurrent()) return;
        state.progress = { done, total };
        broadcastState();
      },
      onCue: (cue) => {
        if (!stillCurrent()) return;
        appendStreamingCue(cue);
        if (state.video) repaintOverlay();
        const now = Date.now();
        if (now - lastCacheWrite >= CACHE_WRITE_INTERVAL_MS) {
          lastCacheWrite = now;
          if (state.cues.size > 0) {
            void setCache(targetUrl, targetLang, {
              translatedAt: now,
              model: MODEL,
              cues: state.cues.snapshot(),
              sourceCues: cues,
              complete: false,
            });
          }
        }
      },
    });

    if (!stillCurrent()) return;

    setCues(translated);
    state.transition("ready", "runTranslation complete");
    broadcastState();

    await setCache(targetUrl, targetLang, {
      translatedAt: Date.now(),
      model: MODEL,
      cues: translated,
      sourceCues: cues,
      complete: true,
    });
  } catch (e) {
    if (e instanceof AbortError || (e as Error).name === "AbortError") return;
    if (!stillCurrent()) return;
    state.error = e instanceof Error ? e.message : String(e);
    state.transition("error", "runTranslation threw");
    broadcastState();
  } finally {
    // Only null if we still own the slot; a concurrent restart may have
    // replaced it with its own controller.
    if (state.abortCtrl === ctrl) state.abortCtrl = null;
  }
}

async function fetchSubtitleText(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, { credentials: "omit", signal });
  if (!res.ok) throw new Error(`Failed to fetch subtitles: ${res.status}`);
  return await res.text();
}

function resetState() {
  clearPerUrlState();
  state.subtitleUrl = null;
  subtitleCandidates.clear();
  if (resolveInterval !== null) {
    window.clearInterval(resolveInterval);
    resolveInterval = null;
  }
  state.transition("idle", "tab reset");
  broadcastState();
}

async function hydrateSourceCues(url: string, cached: { sourceCues?: Cue[] }) {
  if (cached.sourceCues && cached.sourceCues.length > 0) {
    setSourceCues(cached.sourceCues);
    return;
  }
  try {
    const text = await fetchSubtitleText(url);
    const parsed = await loadCues(url, text, fetchSubtitleText);
    if (parsed.length > 0) setSourceCues(parsed);
  } catch {
    // calibration just won't run — not fatal
  }
}

// Prime Video fetches several subtitle tracks in parallel at session start
// (primary + other languages). We can't tell which is active from the URL
// alone — they're opaque UUIDs — so we prefetch each candidate's cues and
// match against whatever text is currently in the native caption DOM. The
// track whose source cues contain the on-screen caption is the active one.
type Candidate = { url: string; cues: Cue[] | null };
const subtitleCandidates = new Map<string, Candidate>();

function handleSubtitleDetected(url: string) {
  if (subtitleCandidates.has(url)) return;
  const entry: Candidate = { url, cues: null };
  subtitleCandidates.set(url, entry);
  void (async () => {
    try {
      const text = await fetchSubtitleText(url);
      entry.cues = await loadCues(url, text, fetchSubtitleText);
    } catch {
      entry.cues = [];
    }
    void considerActiveTrack();
  })();
  void considerActiveTrack();
}

function pickCandidateByNative(): Candidate | null {
  const raw = nativeCaptionEl()?.textContent?.trim();
  if (!raw) return null;
  const target = normalizeCueText(raw);
  if (!target) return null;
  for (const c of subtitleCandidates.values()) {
    if (!c.cues) continue;
    if (c.cues.some((x) => normalizeCueText(x.text) === target)) return c;
  }
  return null;
}

let resolveInterval: number | null = null;
async function considerActiveTrack() {
  // If native caption text matches any loaded candidate, prefer it — that's
  // the track Prime Video is actually rendering.
  const matched = pickCandidateByNative();
  if (matched && matched.url !== state.subtitleUrl) {
    if (resolveInterval !== null) {
      window.clearInterval(resolveInterval);
      resolveInterval = null;
    }
    await applySubtitleUrl(matched.url);
    return;
  }
  // Fallback: if we haven't locked onto any URL yet and all fetched
  // candidates are done loading, pick the one with the most cues. Ancillary
  // tracks (forced-narrative, intro cards) have a handful of cues; the main
  // episode track has hundreds.
  if (!state.subtitleUrl && subtitleCandidates.size > 0) {
    const all = [...subtitleCandidates.values()];
    if (all.every((c) => c.cues !== null)) {
      const best = all.reduce((a, b) => ((a.cues?.length ?? 0) >= (b.cues?.length ?? 0) ? a : b));
      if (best.cues && best.cues.length > 0) {
        if (resolveInterval !== null) {
          window.clearInterval(resolveInterval);
          resolveInterval = null;
        }
        await applySubtitleUrl(best.url);
        return;
      }
    }
  }
  // Still nothing actionable — poll so we re-check as candidates finish
  // loading and as native captions start appearing.
  if (!state.subtitleUrl && resolveInterval === null) {
    resolveInterval = window.setInterval(() => {
      void considerActiveTrack();
    }, 500);
  }
}

// Clear per-URL state via the store, then blank the overlay (owned here).
function clearPerUrlState() {
  state.clearPerUrl();
  setOverlayText("");
}

// The main episode has a long duration; the background-looping trailer on
// the detail page is short (~1–2 min). Translating before the user hits
// Play wastes API calls on the wrong video, so gate on real playback.
const MAIN_VIDEO_MIN_DURATION = 300;
function isMainVideoPlaying(): boolean {
  return Array.from(document.querySelectorAll("video")).some(
    (v) => !v.paused && v.videoWidth > 0 && v.duration > MAIN_VIDEO_MIN_DURATION,
  );
}

// Given state.subtitleUrl is set, hydrate from cache (if any) and start or
// resume translation when appropriate.
async function loadOrTranslate() {
  if (!state.subtitleUrl) return;
  const cached = await getCache(state.subtitleUrl, state.targetLanguage);
  if (cached) {
    setCues(cached.cues);
    await hydrateSourceCues(state.subtitleUrl, cached);
    const video = findVideo();
    if (video) attachVideoSync(video);
    const isPartial = cached.complete === false;
    if (isPartial && state.enabled && isMainVideoPlaying()) {
      void runTranslation(cached.cues.slice());
      return;
    }
    // Partial cache without playback → stay in "detected" so the popup and
    // icon reflect that we'll resume on play, not that we're done.
    state.transition(isPartial ? "detected" : "ready", "cache hydrated");
    broadcastState();
    return;
  }
  state.transition("detected", "subtitle detected, no cache");
  broadcastState();
  if (state.enabled && isMainVideoPlaying()) void runTranslation(null);
}

async function applySubtitleUrl(url: string) {
  if (state.subtitleUrl === url) return;
  clearPerUrlState();
  state.subtitleUrl = url;
  await loadOrTranslate();
}

async function onTargetLanguageChanged() {
  const url = state.subtitleUrl;
  clearPerUrlState();
  if (!url) {
    state.transition("idle", "target language changed, no URL");
    broadcastState();
    return;
  }
  state.subtitleUrl = url; // clearPerUrlState left it alone, but keep explicit
  await loadOrTranslate();
}

function onEnabledChanged(next: boolean) {
  const prev = state.enabled;
  state.enabled = next;
  if (!next) {
    // Turn off: cancel any in-flight translation and blank the overlay.
    state.abortCtrl?.abort();
    state.abortCtrl = null;
    setOverlayText("");
    if (state.status === "translating") {
      state.transition(state.subtitleUrl ? "detected" : "idle", "disabled while translating");
    }
    broadcastState();
    return;
  }
  broadcastState();
  if (!prev && state.subtitleUrl && state.status !== "translating") {
    void loadOrTranslate();
  }
}

// Poll the video element state instead of relying on play/pause events. Prime
// Video swaps video elements (trailer → episode) and the `play` event can
// fire before `duration` is loaded, making event-based detection flaky.
// Polling checks the truth at the end (is a long-duration video playing?)
// every 500ms and reacts to transitions.
function watchForPlayback() {
  let wasPlayingMain = false;
  window.setInterval(() => {
    const playing = isMainVideoPlaying();
    if (playing === wasPlayingMain) return;
    wasPlayingMain = playing;
    if (playing) {
      // Transitioned to playing — start/resume if we have a URL and nothing
      // is currently running.
      if (state.subtitleUrl && state.status !== "translating") {
        void loadOrTranslate();
      }
    } else {
      // Transitioned to not-playing — abort any in-flight run. Partial cache
      // from the last write (≤2s ago) survives; the next play resumes.
      if (state.status === "translating") {
        state.abortCtrl?.abort();
        state.abortCtrl = null;
        state.transition("detected", "playback paused mid-translation");
        broadcastState();
      }
    }
  }, 500);
}

function watchForVideo() {
  let throttle: number | null = null;
  const tick = () => {
    throttle = null;
    const video = findVideo();
    if (video && video !== state.video && state.cues.size > 0) {
      attachVideoSync(video);
    }
  };
  const schedule = () => {
    if (throttle !== null) return;
    throttle = window.setTimeout(tick, 500);
  };
  const observer = new MutationObserver(schedule);
  // Observe only the body subtree for childList changes, without attribute noise
  const target = document.body ?? document.documentElement;
  observer.observe(target, { childList: true, subtree: true });
}

chrome.runtime.onMessage.addListener((raw: ExtensionMessage) => {
  switch (raw.type) {
    case "SUBTITLE_DETECTED":
      void handleSubtitleDetected(raw.url);
      break;
    case "TAB_RESET":
      resetState();
      break;
    case "POPUP_GET_STATE":
      broadcastState();
      break;
  }
});

// Load all settings before announcing readiness, so the message handlers
// don't act on default values (e.g. auto-starting when user actually has
// enabled=false).
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
  applyHideOriginal();
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
    applyHideOriginal();
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

watchForVideo();
watchForPlayback();

window.addEventListener("resize", updateOverlayPosition);
document.addEventListener("fullscreenchange", updateOverlayPosition);
// When the page is going away (tab close, navigation), abort any in-flight
// translation so the fetch is cancelled and the partial cache write we did
// during streaming is what the next visit picks up.
window.addEventListener("pagehide", () => {
  state.abortCtrl?.abort();
});
