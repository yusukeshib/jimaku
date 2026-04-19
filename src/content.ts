import { getApiKey, getCache, setCache } from "./lib/cache";
import { AbortError, MODEL, translateCues } from "./lib/translate";
import { parseVtt } from "./lib/vtt";
import type { ContentReady, ExtensionMessage, TranslatedCue } from "./types";

const OVERLAY_HOST_ID = "prime-ja-subs-host";
const BUTTON_HOST_ID = "prime-ja-subs-button-host";

type Status = "idle" | "detected" | "translating" | "ready" | "error";

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
};

function findVideo(): HTMLVideoElement | null {
  const videos = Array.from(document.querySelectorAll("video"));
  return videos.find((v) => v.videoWidth > 0 && v.videoHeight > 0) ?? videos[0] ?? null;
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

function ensureButtonHost(): ShadowRoot {
  const existing = document.getElementById(BUTTON_HOST_ID);
  if (existing?.shadowRoot) return existing.shadowRoot;

  const host = document.createElement("div");
  host.id = BUTTON_HOST_ID;
  Object.assign(host.style, {
    position: "fixed",
    right: "16px",
    top: "64px",
    zIndex: "2147483647",
  });
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    .btn {
      font-family: system-ui, -apple-system, "Hiragino Kaku Gothic ProN", sans-serif;
      background: rgba(20,20,20,0.85);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.3);
      border-radius: 8px;
      padding: 8px 14px;
      font-size: 13px;
      cursor: pointer;
      backdrop-filter: blur(6px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    .btn:hover { background: rgba(40,40,40,0.95); }
    .btn[disabled] { cursor: default; opacity: 0.85; }
    .note { font-size: 11px; opacity: 0.7; display: block; margin-top: 2px; }
    .hidden { display: none; }
  `;
  root.appendChild(style);
  const btn = document.createElement("button");
  btn.className = "btn";
  btn.addEventListener("click", onButtonClick);
  root.appendChild(btn);
  return root;
}

function renderButton() {
  const root = ensureButtonHost();
  const btn = root.querySelector(".btn") as HTMLButtonElement;
  switch (state.status) {
    case "idle":
      btn.classList.add("hidden");
      break;
    case "detected":
      btn.classList.remove("hidden");
      btn.disabled = false;
      btn.innerHTML = `🇯🇵 日本語字幕を生成<span class="note">Claude Opus 4.7 / 初回のみ課金</span>`;
      break;
    case "translating": {
      btn.classList.remove("hidden");
      btn.disabled = true;
      const p = state.progress;
      const pct = p ? Math.round((p.done / Math.max(1, p.total)) * 100) : 0;
      btn.innerHTML = `翻訳中… ${p?.done ?? 0}/${p?.total ?? "?"} (${pct}%)`;
      break;
    }
    case "ready":
      btn.classList.add("hidden");
      break;
    case "error":
      btn.classList.remove("hidden");
      btn.disabled = false;
      btn.innerHTML = `⚠ エラー (クリックで再試行)<span class="note">${escapeHtml((state.error ?? "").slice(0, 80))}</span>`;
      break;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
    const cue = findCueAt(video.currentTime);
    setOverlayText(cue ? cue.ja : "");
  };
  video.addEventListener("timeupdate", onUpdate);
  state.cleanupVideo = () => {
    video.removeEventListener("timeupdate", onUpdate);
    state.video = null;
    state.cleanupVideo = null;
  };
}

async function onButtonClick() {
  if (state.status === "error") {
    state.error = null;
    state.status = state.subtitleUrl ? "detected" : "idle";
    renderButton();
    return;
  }
  if (state.status !== "detected" || !state.subtitleUrl) return;

  const apiKey = await getApiKey();
  if (!apiKey) {
    state.status = "error";
    state.error = "APIキーが未設定です。拡張機能のオプションから入力してください。";
    renderButton();
    return;
  }

  state.status = "translating";
  state.progress = { done: 0, total: 0 };
  state.abortCtrl = new AbortController();
  const { signal } = state.abortCtrl;
  renderButton();

  const targetUrl = state.subtitleUrl;

  try {
    const vtt = await fetchSubtitleText(targetUrl, signal);
    const cues = parseVtt(vtt);
    if (cues.length === 0) {
      throw new Error("字幕をパースできませんでした（WebVTT形式のみ対応）");
    }

    state.progress = { done: 0, total: cues.length };
    renderButton();

    const translated = await translateCues(cues, apiKey, {
      signal,
      onProgress: (done, total) => {
        if (state.subtitleUrl !== targetUrl) return;
        state.progress = { done, total };
        renderButton();
      },
    });

    if (state.subtitleUrl !== targetUrl) return; // SPA navigated away

    setCues(translated);
    state.status = "ready";
    renderButton();

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
    renderButton();
  } finally {
    state.abortCtrl = null;
  }
}

async function fetchSubtitleText(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, { credentials: "include", signal });
  if (!res.ok) throw new Error(`字幕の取得に失敗: ${res.status}`);
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
  renderButton();
}

async function handleSubtitleDetected(url: string) {
  if (state.subtitleUrl === url) return;
  state.subtitleUrl = url;

  const cached = await getCache(url);
  if (cached) {
    setCues(cached.cues);
    state.status = "ready";
    renderButton();
    const video = findVideo();
    if (video) attachVideoSync(video);
    return;
  }

  if (state.status !== "translating") {
    state.status = "detected";
    renderButton();
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
  }
});

// Tell background we're ready so it can replay any URLs it already captured.
const readyMsg: ContentReady = { type: "CONTENT_READY" };
chrome.runtime.sendMessage(readyMsg).catch(() => {});

watchForVideo();
