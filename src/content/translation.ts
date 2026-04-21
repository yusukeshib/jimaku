import { getApiKey, getCache, setCache } from "../lib/cache";
import { loadCues } from "../lib/subtitle";
import { AbortError, MODEL, translateCues } from "../lib/translate";
import type { Cue, PlaybackState } from "../types";
import { attachCalibration } from "./calibration";
import { findVideo, isMainVideoPlaying } from "./playback";
import { state } from "./state";

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

/**
 * Bind a video element to calibration + lifecycle cleanup. Cue painting is
 * handled by a state subscriber in the orchestrator (content.ts), not here.
 */
export function attachVideoSync(video: HTMLVideoElement) {
  if (state.video === video) return;
  state.cleanupVideo?.();
  state.cleanupCalibration?.();
  state.video = video;

  const disposeCalibration = attachCalibration(video);

  state.cleanupVideo = () => {
    state.video = null;
    state.cleanupVideo = null;
  };
  state.cleanupCalibration = () => {
    disposeCalibration();
    state.cleanupCalibration = null;
  };
}

// --- Translation run ---

async function runTranslation(resumeFrom: Cue[] | null) {
  if (!state.enabled || !state.subtitleUrl) return;
  // Guard on the abort controller, not on phase. Phase can lag (e.g. an
  // aborted prior run's `finally` hasn't executed yet) which would wrongly
  // block a freshly-kicked translation.
  if (state.abortCtrl !== null) return;

  const apiKey = await getApiKey();
  if (!apiKey) {
    state.onTranslationFailed("No API key set. Open the extension options to add one.");
    return;
  }

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

    const resumeCues = resumeFrom ? state.cues.snapshot() : null;
    state.onTranslationStarted(cues.length, resumeCues);

    const earlyVideo = findVideo();
    if (earlyVideo) attachVideoSync(earlyVideo);

    let lastCacheWrite = 0;
    const CACHE_WRITE_INTERVAL_MS = 2000;

    const translated = await translateCues(cues, apiKey, {
      signal,
      targetLanguage: targetLang,
      resumeFrom: resumeCues ?? undefined,
      onProgress: (done, total) => {
        if (!stillCurrent()) return;
        state.onTranslationProgress(done, total);
      },
      onCue: (cue) => {
        if (!stillCurrent()) return;
        state.onTranslationCueAppended(cue);
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

    state.onTranslationComplete(translated);

    await setCache(targetUrl, targetLang, {
      translatedAt: Date.now(),
      model: MODEL,
      cues: translated,
      sourceCues: cues,
      complete: true,
    });
  } catch (e) {
    if (e instanceof AbortError || (e as Error).name === "AbortError") {
      state.onTranslationAborted();
      return;
    }
    if (!stillCurrent()) return;
    state.onTranslationFailed(e instanceof Error ? e.message : String(e));
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
    const isPartial = cached.complete === false;
    state.onCachedCuesHydrated(cached.cues, !isPartial);
    await hydrateSourceCues(state.subtitleUrl, cached);
    const video = findVideo();
    if (video) attachVideoSync(video);
    if (isPartial && state.enabled && isMainVideoPlaying()) {
      void runTranslation(cached.cues.slice());
    }
    return;
  }
  // No cache. Phase stays "idle"; runTranslation will flip to "translating".
  if (state.enabled && isMainVideoPlaying()) void runTranslation(null);
}

/** Switch to a new subtitle URL (typically fired by the track resolver). */
export async function applySubtitleUrl(url: string) {
  if (state.subtitleUrl === url) return;
  state.onSubtitleUrlSwitching();
  state.onSubtitleDetected(url);
  await loadOrTranslate();
}

/** User changed the target language — drop state for the old language and
 *  re-evaluate under the new one. */
export async function onTargetLanguageChanged() {
  const url = state.subtitleUrl;
  state.onSubtitleUrlSwitching();
  if (!url) return;
  state.onSubtitleDetected(url);
  await loadOrTranslate();
}

/** User flipped the Auto-translate toggle. */
export function onEnabledChanged(next: boolean) {
  const prev = state.enabled;
  state.setEnabled(next);
  if (!next) {
    state.abortCtrl?.abort();
    state.abortCtrl = null;
    return;
  }
  if (!prev && state.subtitleUrl && state.phase !== "translating") {
    void loadOrTranslate();
  }
}

/** Playback transitions — start/resume on play, abort only when the user
 *  leaves the playback page (video element gone). Pausing in the player
 *  lets the in-flight translation keep running so resume is seamless. */
export function onPlaybackChange(next: PlaybackState) {
  state.onPlaybackChanged(next);
  if (next === "playing") {
    if (state.subtitleUrl && state.phase !== "translating") void loadOrTranslate();
    return;
  }
  if (next === "absent" && state.phase === "translating") {
    state.abortCtrl?.abort();
    state.abortCtrl = null;
  }
}

/** A qualifying video element appeared — attach sync if we're translating. */
export function onVideoFound(video: HTMLVideoElement) {
  if (video !== state.video && state.cues.size > 0) attachVideoSync(video);
}
