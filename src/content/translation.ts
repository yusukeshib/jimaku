import { getApiKey, getCache, setCache } from "../lib/cache";
import { loadCues } from "../lib/subtitle";
import { AbortError, MODEL, translateCues } from "../lib/translate";
import type { Cue, TranslatedCue } from "../types";
import { attachCalibration } from "./calibration";
import { setOverlayText, updateOverlayPosition } from "./overlay";
import { findVideo, isMainVideoPlaying } from "./playback";
import { state } from "./state";

export type TranslationCallbacks = {
  /** Broadcast status / progress changes to background + popup. */
  broadcast: () => void;
  /** Position context for the overlay. Provided by the orchestrator so the
   *  translation controller doesn't need to know about hideOriginal etc. */
  getPosContext: () => { video: HTMLVideoElement | null; hideOriginal: boolean };
};

let cbs: TranslationCallbacks = {
  broadcast: () => {},
  getPosContext: () => ({ video: null, hideOriginal: false }),
};

export function configureTranslation(next: TranslationCallbacks) {
  cbs = next;
}

// --- Internal helpers ---

async function fetchSubtitleText(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, { credentials: "omit", signal });
  if (!res.ok) throw new Error(`Failed to fetch subtitles: ${res.status}`);
  return await res.text();
}

/** Hydrate source cues from cache if present, else fetch TTML. Swallows errors. */
async function hydrateSourceCues(url: string, cached: { sourceCues?: Cue[] }) {
  if (cached.sourceCues && cached.sourceCues.length > 0) {
    state.sourceIndex.set(cached.sourceCues);
    return;
  }
  try {
    const text = await fetchSubtitleText(url);
    const parsed = await loadCues(url, text, fetchSubtitleText);
    if (parsed.length > 0) state.sourceIndex.set(parsed);
  } catch {
    // Calibration just won't run — not fatal.
  }
}

function paintCurrentCue() {
  if (!state.showTranslated) {
    setOverlayText("");
    return;
  }
  const v = state.video;
  if (!v) return;
  const cue = state.cues.findAt(v.currentTime - state.timeOffset);
  setOverlayText(cue ? cue.text : "");
  updateOverlayPosition(cbs.getPosContext());
}

export function repaintOverlay() {
  paintCurrentCue();
}

/**
 * Bind a video element to the overlay: timeupdate drives the cue display
 * and calibration keeps `state.timeOffset` in sync with Prime Video's
 * native caption stream.
 */
export function attachVideoSync(video: HTMLVideoElement) {
  if (state.video === video) return;
  state.cleanupVideo?.();
  state.cleanupCalibration?.();
  state.video = video;

  const onTimeUpdate = () => paintCurrentCue();
  video.addEventListener("timeupdate", onTimeUpdate);
  const disposeCalibration = attachCalibration(video, paintCurrentCue);

  state.cleanupVideo = () => {
    video.removeEventListener("timeupdate", onTimeUpdate);
    state.video = null;
    state.cleanupVideo = null;
  };
  state.cleanupCalibration = () => {
    disposeCalibration();
    state.cleanupCalibration = null;
  };
}

/** Clear per-URL state and blank the overlay. */
function clearPerUrl() {
  state.clearPerUrl();
  setOverlayText("");
}

// --- Translation run ---

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
    cbs.broadcast();
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
      state.sourceIndex.set(cues);
    }

    if (resumeFrom && resumeFrom.length > 0) state.cues.set(resumeFrom);
    else state.cues.clear();
    state.progress = { done: resumeFrom?.length ?? 0, total: cues.length };
    cbs.broadcast();

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
        cbs.broadcast();
      },
      onCue: (cue) => {
        if (!stillCurrent()) return;
        state.cues.append(cue);
        if (state.video) paintCurrentCue();
        const now = Date.now();
        if (now - lastCacheWrite >= CACHE_WRITE_INTERVAL_MS && state.cues.size > 0) {
          lastCacheWrite = now;
          void setCache(targetUrl, targetLang, {
            translatedAt: now,
            model: MODEL,
            cues: state.cues.snapshot(),
            sourceCues: cues,
            complete: false,
          });
        }
      },
    });

    if (!stillCurrent()) return;

    state.cues.set(translated);
    state.transition("ready", "runTranslation complete");
    cbs.broadcast();

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
    cbs.broadcast();
  } finally {
    if (state.abortCtrl === ctrl) state.abortCtrl = null;
  }
}

// --- Public API ---

/**
 * Given `state.subtitleUrl` is set, hydrate from cache (if any) and start
 * or resume translation when playback is active.
 */
export async function loadOrTranslate() {
  if (!state.subtitleUrl) return;
  const cached = await getCache(state.subtitleUrl, state.targetLanguage);
  if (cached) {
    state.cues.set(cached.cues);
    await hydrateSourceCues(state.subtitleUrl, cached);
    const video = findVideo();
    if (video) attachVideoSync(video);
    const isPartial = cached.complete === false;
    if (isPartial && state.enabled && isMainVideoPlaying()) {
      void runTranslation(cached.cues.slice());
      return;
    }
    state.transition(isPartial ? "detected" : "ready", "cache hydrated");
    cbs.broadcast();
    return;
  }
  state.transition("detected", "subtitle detected, no cache");
  cbs.broadcast();
  if (state.enabled && isMainVideoPlaying()) void runTranslation(null);
}

/** Switch to a new subtitle URL (typically fired by the track resolver). */
export async function applySubtitleUrl(url: string) {
  if (state.subtitleUrl === url) return;
  clearPerUrl();
  state.subtitleUrl = url;
  await loadOrTranslate();
}

/** User changed the target language — drop state for the old language and
 *  re-evaluate under the new one. */
export async function onTargetLanguageChanged() {
  const url = state.subtitleUrl;
  clearPerUrl();
  if (!url) {
    state.transition("idle", "target language changed, no URL");
    cbs.broadcast();
    return;
  }
  state.subtitleUrl = url;
  await loadOrTranslate();
}

/** User flipped the Auto-translate toggle. */
export function onEnabledChanged(next: boolean) {
  const prev = state.enabled;
  state.enabled = next;
  if (!next) {
    state.abortCtrl?.abort();
    state.abortCtrl = null;
    setOverlayText("");
    if (state.status === "translating") {
      state.transition(state.subtitleUrl ? "detected" : "idle", "disabled while translating");
    }
    cbs.broadcast();
    return;
  }
  cbs.broadcast();
  if (!prev && state.subtitleUrl && state.status !== "translating") {
    void loadOrTranslate();
  }
}

/** Playback started or stopped — start/resume or abort in-flight. */
export function onPlaybackChange(playing: boolean) {
  if (playing) {
    if (state.subtitleUrl && state.status !== "translating") void loadOrTranslate();
    return;
  }
  if (state.status === "translating") {
    state.abortCtrl?.abort();
    state.abortCtrl = null;
    state.transition("detected", "playback paused mid-translation");
    cbs.broadcast();
  }
}

/** A qualifying video element appeared — attach sync if we're translating. */
export function onVideoFound(video: HTMLVideoElement) {
  if (video !== state.video && state.cues.size > 0) attachVideoSync(video);
}

/** Reset everything for this tab (fired on TAB_RESET). */
export function resetForTabReset() {
  clearPerUrl();
  state.subtitleUrl = null;
  state.transition("idle", "tab reset");
  cbs.broadcast();
}
