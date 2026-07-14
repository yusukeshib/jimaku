import {
  clearProviderKey,
  getCache,
  getProviderConfig,
  getProviderKey,
  setCache,
} from "../lib/cache";
import type { ProviderConfig } from "../lib/providers";
import { ProviderHttpError } from "../lib/providers";
import { loadCues } from "../lib/subtitle";
import { AbortError, translateCues } from "../lib/translate";
import { currentPlatform } from "../platforms";
import type { Cue, PlaybackState, Usage } from "../types";
import { isMainVideoPlaying } from "./playback";
import { state } from "./state";

function mergeUsage(prior: Usage | null | undefined, fresh: Usage | null): Usage | null {
  if (!prior) return fresh;
  if (!fresh) return prior;
  const merged: Usage = {
    inputTokens: prior.inputTokens + fresh.inputTokens,
    outputTokens: prior.outputTokens + fresh.outputTokens,
  };
  const cacheRead = (prior.cacheReadTokens ?? 0) + (fresh.cacheReadTokens ?? 0);
  if (cacheRead > 0) merged.cacheReadTokens = cacheRead;
  const cacheCreation = (prior.cacheCreationTokens ?? 0) + (fresh.cacheCreationTokens ?? 0);
  if (cacheCreation > 0) merged.cacheCreationTokens = cacheCreation;
  if (typeof prior.reportedCostUsd === "number" || typeof fresh.reportedCostUsd === "number") {
    merged.reportedCostUsd = (prior.reportedCostUsd ?? 0) + (fresh.reportedCostUsd ?? 0);
  }
  return merged;
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

/** Map a translation failure to a user-facing message. A 401 means the
 *  stored key no longer maps to a valid account (revoked/deleted). For
 *  OpenRouter we clear the stored key so the popup flips back to its
 *  "connect" state (reconnect is one click) instead of resurfacing the same
 *  opaque 401 on every attempt. Hand-pasted keys (Anthropic/OpenAI) are kept
 *  — a transient provider-side 401 shouldn't wipe a key the user typed in.  */
async function describeTranslationError(e: unknown, config: ProviderConfig): Promise<string> {
  if (e instanceof ProviderHttpError && e.status === 401) {
    if (config.id === "openrouter") {
      // Only clear if the stored key still matches the one that produced this
      // 401 — otherwise a stale in-flight request could wipe a key the user
      // just reconnected with.
      const currentKey = await getProviderKey(config.id);
      if (currentKey === config.apiKey) {
        await clearProviderKey(config.id);
      }
      return "OpenRouter rejected the saved key (it may have been revoked). Reconnect from the popup.";
    }
    return "The saved API key was rejected (401). Check or re-enter your key from the popup.";
  }
  return e instanceof Error ? e.message : String(e);
}

// --- Translation run ---

async function runTranslation(resumeFrom: Cue[] | null, priorUsage: Usage | null) {
  if (!state.enabled || !state.subtitleUrl) return;
  // No API key yet — stay in idle rather than flipping to error. The storage
  // listener re-kicks translation once a key lands.
  if (!state.providerReady) return;
  // Guard on the abort controller, not on phase. Phase can lag (e.g. an
  // aborted prior run's `finally` hasn't executed yet) which would wrongly
  // block a freshly-kicked translation.
  if (state.abortCtrl !== null) return;

  const providerConfig = await getProviderConfig();
  if (!providerConfig) return;

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

    const title = currentPlatform()?.findTitle() ?? undefined;
    const pageUrl = window.location.href;

    let lastCacheWrite = 0;
    const CACHE_WRITE_INTERVAL_MS = 2000;

    const { cues: translated, usage: freshUsage } = await translateCues(cues, providerConfig, {
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
            model: providerConfig.model,
            cues: state.cues.snapshot(),
            sourceCues: cues,
            complete: false,
            title,
            pageUrl,
            lang: targetLang,
            provider: providerConfig.id,
            usage: priorUsage ?? undefined,
          });
        }
      },
    });

    if (!stillCurrent()) return;

    state.onTranslationComplete(translated);

    const totalUsage = mergeUsage(priorUsage, freshUsage);
    await setCache(targetUrl, targetLang, {
      translatedAt: Date.now(),
      model: providerConfig.model,
      cues: translated,
      sourceCues: cues,
      complete: true,
      title,
      pageUrl,
      lang: targetLang,
      provider: providerConfig.id,
      usage: totalUsage ?? undefined,
    });
  } catch (e) {
    if (e instanceof AbortError || (e as Error).name === "AbortError") {
      state.onTranslationAborted();
      return;
    }
    if (!stillCurrent()) return;
    const message = await describeTranslationError(e, providerConfig);
    if (!stillCurrent()) return;
    state.onTranslationFailed(message);
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
    if (isPartial && state.enabled && isMainVideoPlaying()) {
      void runTranslation(cached.cues.slice(), cached.usage ?? null);
    }
    return;
  }
  // No cache. Phase stays "idle"; runTranslation will flip to "translating".
  if (state.enabled && isMainVideoPlaying()) void runTranslation(null, null);
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

/** A provider key has just been saved. Caller has already flipped
 *  `state.providerReady` to true. Kick translation if the page is ready. */
export function onProviderReadyChanged() {
  if (!state.enabled) return;
  if (state.subtitleUrl && state.phase !== "translating") {
    void loadOrTranslate();
  }
}

/** User flipped the Enable Jimaku toggle. */
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
export function onPlaybackTransition(next: PlaybackState) {
  if (next === "playing") {
    if (!state.subtitleUrl) return;
    if (state.phase !== "translating") void loadOrTranslate();
    return;
  }
  if (next === "absent" && state.phase === "translating") {
    state.abortCtrl?.abort();
    state.abortCtrl = null;
  }
}
