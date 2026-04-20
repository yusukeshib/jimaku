import { deleteCache, getApiKey, getCache, getOffsetSeconds, setCache } from "./lib/cache";
import { loadCues } from "./lib/subtitle";
import { AbortError, MODEL, translateCues } from "./lib/translate";
import type {
  ContentReady,
  ExtensionMessage,
  StateSnapshot,
  StateUpdate,
  Status,
  TranslatedCue,
} from "./types";

const OVERLAY_HOST_ID = "jimaku-host";

type State = {
  subtitleUrl: string | null;
  cues: TranslatedCue[] | null;
  sortedStarts: number[] | null;
  video: HTMLVideoElement | null;
  status: Status;
  progress: { done: number; total: number } | null;
  error: string | null;
  abortCtrl: AbortController | null;
  cleanupVideo: (() => void) | null;
  offsetSeconds: number;
};

const state: State = {
  subtitleUrl: null,
  cues: null,
  sortedStarts: null,
  video: null,
  status: "idle",
  progress: null,
  error: null,
  abortCtrl: null,
  cleanupVideo: null,
  offsetSeconds: 0,
};

function snapshot(): StateSnapshot {
  return {
    status: state.status,
    progress: state.progress,
    error: state.error,
    hasSubtitle: state.subtitleUrl !== null,
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
      top: 8%;
      transform: translateX(-50%);
      max-width: 80%;
      padding: 6px 12px;
      font-family: "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif;
      font-size: min(3.5vw, 32px);
      line-height: 1.35;
      color: #fff;
      text-align: center;
      text-shadow:
        -1px -1px 0 #000, 1px -1px 0 #000,
        -1px  1px 0 #000, 1px  1px 0 #000,
        0 0 4px rgba(0,0,0,0.9);
      background: rgba(0,0,0,0.25);
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

function attachVideoSync(video: HTMLVideoElement) {
  if (state.video === video) return;
  state.cleanupVideo?.();
  state.video = video;
  const onUpdate = () => {
    const cue = findCueAt(video.currentTime - state.offsetSeconds);
    setOverlayText(cue ? cue.ja : "");
  };
  video.addEventListener("timeupdate", onUpdate);
  state.cleanupVideo = () => {
    video.removeEventListener("timeupdate", onUpdate);
    state.video = null;
    state.cleanupVideo = null;
  };
}

async function startTranslation() {
  if (state.status === "error") {
    state.error = null;
    state.status = state.subtitleUrl ? "detected" : "idle";
    broadcastState();
    return;
  }
  if (state.status !== "detected" || !state.subtitleUrl) return;

  const apiKey = await getApiKey();
  if (!apiKey) {
    state.status = "error";
    state.error = "No API key set. Open the extension options to add one.";
    broadcastState();
    return;
  }

  state.status = "translating";
  state.progress = { done: 0, total: 0 };
  state.abortCtrl = new AbortController();
  const { signal } = state.abortCtrl;
  broadcastState();

  const targetUrl = state.subtitleUrl;

  try {
    const text = await fetchSubtitleText(targetUrl, signal);
    const cues = await loadCues(targetUrl, text, fetchSubtitleText, signal);
    if (cues.length === 0) {
      throw new Error("Subtitle parse produced no cues");
    }

    state.progress = { done: 0, total: cues.length };
    broadcastState();

    const translated = await translateCues(cues, apiKey, {
      signal,
      onProgress: (done, total) => {
        if (state.subtitleUrl !== targetUrl) return;
        state.progress = { done, total };
        broadcastState();
      },
    });

    if (state.subtitleUrl !== targetUrl) return; // SPA navigated away

    setCues(translated);
    state.status = "ready";
    broadcastState();

    await setCache(targetUrl, {
      translatedAt: Date.now(),
      model: MODEL,
      cues: translated,
    });

    const video = findVideo();
    if (video) attachVideoSync(video);
  } catch (e) {
    if (e instanceof AbortError || (e as Error).name === "AbortError") return;
    if (state.subtitleUrl !== targetUrl) return;
    state.status = "error";
    state.error = e instanceof Error ? e.message : String(e);
    broadcastState();
  } finally {
    state.abortCtrl = null;
  }
}

async function regenerate() {
  const url = state.subtitleUrl;
  if (!url) return;
  state.abortCtrl?.abort();
  state.abortCtrl = null;
  state.cleanupVideo?.();
  setOverlayText("");
  state.cues = null;
  state.sortedStarts = null;
  state.progress = null;
  state.error = null;
  await deleteCache(url);
  state.status = "detected";
  broadcastState();
  await startTranslation();
}

async function fetchSubtitleText(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, { credentials: "omit", signal });
  if (!res.ok) throw new Error(`Failed to fetch subtitles: ${res.status}`);
  return await res.text();
}

function resetState() {
  state.abortCtrl?.abort();
  state.cleanupVideo?.();
  state.subtitleUrl = null;
  state.cues = null;
  state.sortedStarts = null;
  state.status = "idle";
  state.progress = null;
  state.error = null;
  state.abortCtrl = null;
  setOverlayText("");
  broadcastState();
}

async function handleSubtitleDetected(url: string) {
  if (state.subtitleUrl === url) return;
  state.subtitleUrl = url;

  const cached = await getCache(url);
  if (cached) {
    setCues(cached.cues);
    state.status = "ready";
    broadcastState();
    const video = findVideo();
    if (video) attachVideoSync(video);
    return;
  }

  if (state.status !== "translating") {
    state.status = "detected";
    broadcastState();
  }
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
    case "POPUP_START":
      void startTranslation();
      break;
    case "POPUP_REGENERATE":
      void regenerate();
      break;
  }
});

// Tell background we're ready so it can replay any URLs it already captured.
const readyMsg: ContentReady = { type: "CONTENT_READY" };
chrome.runtime.sendMessage(readyMsg).catch(() => {});

void getOffsetSeconds().then((s) => {
  state.offsetSeconds = s;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.offsetSeconds) state.offsetSeconds = Number(changes.offsetSeconds.newValue) || 0;
});

watchForVideo();
