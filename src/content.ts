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

const OVERLAY_HOST_ID = "jimaku-host";
const HIDE_ORIGINAL_STYLE_ID = "jimaku-hide-original";

// Selectors for positioning (prefer the text span — the overlay container
// covers the whole player, which is useless as a position anchor).
const CAPTION_TEXT_SELECTORS = [
  ".atvwebplayersdk-captions-text",
  '.webPlayerSDKContainer [class*="caption"][class*="text"]',
];

// Broader selectors used only to hide Prime Video's native captions.
const CAPTION_HIDE_SELECTORS = [
  ".atvwebplayersdk-captions-overlay",
  ".atvwebplayersdk-captions-text",
  '.webPlayerSDKContainer [class*="captions"]',
];

const HIDE_ORIGINAL_CSS = `
  ${CAPTION_HIDE_SELECTORS.join(",\n  ")} {
    visibility: hidden !important;
  }
`;

// State lives in ./content/state — this file is the orchestrator.

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

function ensureOverlayHost(): ShadowRoot {
  const existing = document.getElementById(OVERLAY_HOST_ID);
  if (existing?.shadowRoot) return existing.shadowRoot;

  const host = document.createElement("div");
  host.id = OVERLAY_HOST_ID;
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    pointerEvents: "none",
    zIndex: "2147483646",
  });
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    .line {
      position: fixed;
      left: 50%;
      top: 88%;
      transform: translate(-50%, -100%);
      max-width: 80%;
      padding: 6px 12px;
      font-family: "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif;
      font-size: min(3.5vw, 32px);
      line-height: 1.35;
      color: #fff;
      text-align: center;
      background: rgba(0, 0, 0, 0.55);
      border-radius: 6px;
      white-space: pre-wrap;
      pointer-events: none;
    }
    .line:empty { display: none; }
  `;
  root.appendChild(style);
  const line = document.createElement("div");
  line.className = "line";
  root.appendChild(line);
  return root;
}

function setOverlayText(text: string) {
  const root = ensureOverlayHost();
  const line = root.querySelector(".line") as HTMLDivElement;
  if (line.textContent !== text) line.textContent = text;
}

function nativeCaptionEl(): HTMLElement | null {
  for (const sel of CAPTION_TEXT_SELECTORS) {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (el) return el;
  }
  return null;
}

let lastCaptionRect: { top: number; height: number } | null = null;

function findCaptionTextRect(): { top: number; height: number } | null {
  const el = nativeCaptionEl();
  if (el) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      lastCaptionRect = { top: r.top, height: r.height };
      return lastCaptionRect;
    }
  }
  return lastCaptionRect;
}

function computeFontSizePx(): number | null {
  // Prefer Prime Video's own caption size when available — it already
  // accounts for the user's caption-size preference, window size, fullscreen.
  const el = nativeCaptionEl();
  if (el) {
    const px = parseFloat(getComputedStyle(el).fontSize);
    if (Number.isFinite(px) && px > 0) return px;
  }
  // Fallback: derive from the video element's height.
  const video = state.video ?? findVideo();
  if (!video) return null;
  const h = video.getBoundingClientRect().height;
  if (h <= 0) return null;
  return Math.max(14, Math.min(36, h * 0.035));
}

function updateOverlayPosition() {
  const root = ensureOverlayHost();
  const line = root.querySelector(".line") as HTMLDivElement;
  const fontPx = computeFontSizePx();
  line.style.fontSize = fontPx !== null ? `${fontPx}px` : "";
  const rect = findCaptionTextRect();
  if (rect) {
    if (state.hideOriginal) {
      // Native captions are hidden via visibility: hidden so their layout box
      // still exists — place ours exactly where the text span sits.
      const centerY = rect.top + rect.height / 2;
      line.style.top = `${centerY}px`;
      line.style.transform = "translate(-50%, -50%)";
    } else {
      // Prime Video puts captions near the bottom most of the time, but
      // occasionally at the top (narration, on-screen labels). Stack above
      // bottom-placed captions and below top-placed ones so the translated
      // line always stays on-screen.
      const video = state.video ?? findVideo();
      const videoMidY = video
        ? video.getBoundingClientRect().top + video.getBoundingClientRect().height / 2
        : window.innerHeight / 2;
      const captionCenterY = rect.top + rect.height / 2;
      if (captionCenterY < videoMidY) {
        // Upper half — stack below.
        line.style.top = `${rect.top + rect.height + 4}px`;
        line.style.transform = "translate(-50%, 0)";
      } else {
        // Lower half — stack above.
        line.style.top = `${rect.top - 4}px`;
        line.style.transform = "translate(-50%, -100%)";
      }
    }
    return;
  }
  const video = state.video ?? findVideo();
  if (video) {
    const r = video.getBoundingClientRect();
    // Fallback: ~12% from the bottom of the video, matching typical caption placement.
    line.style.top = `${r.bottom - r.height * 0.12}px`;
    line.style.transform = "translate(-50%, -50%)";
    return;
  }
  line.style.top = "";
  line.style.transform = "";
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
  const existing = document.getElementById(HIDE_ORIGINAL_STYLE_ID);
  if (state.hideOriginal) {
    if (!existing) {
      const style = document.createElement("style");
      style.id = HIDE_ORIGINAL_STYLE_ID;
      style.textContent = HIDE_ORIGINAL_CSS;
      (document.head ?? document.documentElement).appendChild(style);
    }
  } else {
    existing?.remove();
  }
  updateOverlayPosition();
}

function findCueAt(seconds: number): TranslatedCue | null {
  const cues = state.cues;
  const starts = state.sortedStarts;
  if (!cues || !starts || cues.length === 0) return null;
  // binary search for the last cue whose start <= seconds
  let lo = 0;
  let hi = starts.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] <= seconds) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx === -1) return null;
  const cue = cues[idx];
  return seconds <= cue.end ? cue : null;
}

function setCues(cues: TranslatedCue[]) {
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  state.cues = sorted;
  state.sortedStarts = sorted.map((c) => c.start);
}

// Insert a streamed cue into the sorted cue list. Streaming emits in
// chronological order so inserts are almost always at the tail (O(1)); we
// keep a safe fallback for any out-of-order emission.
function appendStreamingCue(cue: TranslatedCue) {
  if (!state.cues) {
    state.cues = [];
    state.sortedStarts = [];
  }
  const arr = state.cues;
  const starts = state.sortedStarts as number[];
  const last = arr[arr.length - 1];
  if (!last || last.start <= cue.start) {
    arr.push(cue);
    starts.push(cue.start);
  } else {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (starts[mid] <= cue.start) lo = mid + 1;
      else hi = mid;
    }
    arr.splice(lo, 0, cue);
    starts.splice(lo, 0, cue.start);
  }
}

function normalizeCueText(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} ]+/gu, "")
    .trim();
}

function setSourceCues(cues: Cue[]) {
  state.sourceCues = cues;
  const map = new Map<string, Cue[]>();
  for (const c of cues) {
    const key = normalizeCueText(c.text);
    if (!key) continue;
    const arr = map.get(key);
    if (arr) arr.push(c);
    else map.set(key, [c]);
  }
  state.sourceByNormText = map;
}

function attachCalibration(video: HTMLVideoElement) {
  state.cleanupCalibration?.();

  let lastSeenText = "";
  const tryCalibrate = () => {
    if (!state.sourceByNormText) return;
    const el = nativeCaptionEl();
    const raw = el?.textContent ?? "";
    if (raw === lastSeenText) return;
    lastSeenText = raw;
    const key = normalizeCueText(raw);
    if (!key) return;
    const matches = state.sourceByNormText.get(key);
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
    if (state.sourceCues && state.sourceCues.length > 0) {
      cues = state.sourceCues;
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
      state.cues = [];
      state.sortedStarts = [];
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
          const partial = state.cues;
          if (partial && partial.length > 0) {
            void setCache(targetUrl, targetLang, {
              translatedAt: now,
              model: MODEL,
              cues: partial.slice(),
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
    if (video && video !== state.video && state.cues) {
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
