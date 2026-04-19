import { parseVtt } from "./lib/vtt";
import { translateCues, MODEL } from "./lib/translate";
import { getApiKey, getCache, setCache } from "./lib/cache";
import type { ExtensionMessage, TranslatedCue } from "./types";

const OVERLAY_HOST_ID = "prime-ja-subs-host";
const BUTTON_HOST_ID = "prime-ja-subs-button-host";

type State = {
  subtitleUrl: string | null;
  cues: TranslatedCue[] | null;
  video: HTMLVideoElement | null;
  status: "idle" | "detected" | "translating" | "ready" | "error";
  progress: { done: number; total: number } | null;
  error: string | null;
};

const state: State = {
  subtitleUrl: null,
  cues: null,
  video: null,
  status: "idle",
  progress: null,
  error: null,
};

function findVideo(): HTMLVideoElement | null {
  const videos = Array.from(document.querySelectorAll("video"));
  return videos.find((v) => v.videoWidth > 0 && v.videoHeight > 0) ?? videos[0] ?? null;
}

function ensureOverlayHost(): ShadowRoot {
  let host = document.getElementById(OVERLAY_HOST_ID);
  if (!host) {
    host = document.createElement("div");
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
  return host.shadowRoot!;
}

function getOverlayLine(): HTMLDivElement {
  const root = ensureOverlayHost();
  return root.querySelector(".line") as HTMLDivElement;
}

function setOverlayText(text: string) {
  getOverlayLine().textContent = text;
}

function ensureButtonHost(): ShadowRoot {
  let host = document.getElementById(BUTTON_HOST_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = BUTTON_HOST_ID;
    Object.assign(host.style, {
      position: "fixed",
      right: "16px",
      top: "16px",
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
  return host.shadowRoot!;
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
      btn.innerHTML = `⚠ エラー<span class="note">${(state.error ?? "").slice(0, 80)}</span>`;
      break;
  }
}

function findCueAt(seconds: number): TranslatedCue | null {
  if (!state.cues) return null;
  for (const c of state.cues) {
    if (seconds >= c.start && seconds <= c.end) return c;
  }
  return null;
}

function attachVideoSync(video: HTMLVideoElement) {
  if (state.video === video) return;
  state.video = video;
  video.addEventListener("timeupdate", () => {
    const cue = findCueAt(video.currentTime);
    setOverlayText(cue ? cue.ja : "");
  });
}

async function onButtonClick() {
  if (state.status === "error") {
    state.status = state.subtitleUrl ? "detected" : "idle";
    state.error = null;
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
  renderButton();

  try {
    const vtt = await fetchSubtitleText(state.subtitleUrl);
    const cues = parseVtt(vtt);
    if (cues.length === 0) throw new Error("字幕をパースできませんでした（WebVTT形式のみ対応）");

    state.progress = { done: 0, total: cues.length };
    renderButton();

    const translated = await translateCues(cues, apiKey, (done, total) => {
      state.progress = { done, total };
      renderButton();
    });

    state.cues = translated;
    state.status = "ready";
    renderButton();

    await setCache(state.subtitleUrl, {
      translatedAt: Date.now(),
      model: MODEL,
      cues: translated,
    });

    const video = findVideo();
    if (video) attachVideoSync(video);
  } catch (e) {
    state.status = "error";
    state.error = e instanceof Error ? e.message : String(e);
    renderButton();
  }
}

async function fetchSubtitleText(url: string): Promise<string> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`字幕の取得に失敗: ${res.status}`);
  return await res.text();
}

async function handleSubtitleDetected(url: string) {
  if (state.subtitleUrl === url) return;
  state.subtitleUrl = url;

  const cached = await getCache(url);
  if (cached) {
    state.cues = cached.cues;
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
  const observer = new MutationObserver(() => {
    const video = findVideo();
    if (video && video !== state.video && state.cues) {
      attachVideoSync(video);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

chrome.runtime.onMessage.addListener((raw: ExtensionMessage) => {
  if (raw.type === "SUBTITLE_DETECTED") {
    void handleSubtitleDetected(raw.url);
  }
});

watchForVideo();
