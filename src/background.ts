import type { ExtensionMessage, StateSnapshot, SubtitleDetected, TabReset } from "./types";

const SUBTITLE_URL_RE = /\.(vtt|dfxp|ttml2?)(\?|$)/i;
const SUBTITLE_PATH_HINT = /(caption|subtitle|timedtext|subtitleset|-subs?-|_subs?_|\/subs\/)/i;
const HINTED_CONTAINER_RE = /\.(xml|json|m3u8)(\?|$)/i;

const urlsByTab = new Map<number, Set<string>>();
const lastTitleKeyByTab = new Map<number, string>();

function titleKeyFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/(?:gp\/video\/detail|detail|dp)\/([A-Z0-9]+)/i);
    return m ? `${u.host}:${m[1]}` : `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

function looksLikeSubtitle(url: string): boolean {
  if (SUBTITLE_URL_RE.test(url)) return true;
  if (SUBTITLE_PATH_HINT.test(url) && HINTED_CONTAINER_RE.test(url)) return true;
  return false;
}

function recordAndNotify(tabId: number, url: string) {
  let seen = urlsByTab.get(tabId);
  if (!seen) {
    seen = new Set();
    urlsByTab.set(tabId, seen);
  }
  if (seen.has(url)) return;
  seen.add(url);

  const msg: SubtitleDetected = { type: "SUBTITLE_DETECTED", url };
  chrome.tabs.sendMessage(tabId, msg).catch(() => {
    // content script not mounted yet — it will request pending URLs via CONTENT_READY
  });
}

function resetTab(tabId: number) {
  urlsByTab.delete(tabId);
  const msg: TabReset = { type: "TAB_RESET" };
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (!looksLikeSubtitle(details.url)) return;
    recordAndNotify(details.tabId, details.url);
  },
  {
    urls: [
      "*://*.amazon.com/*",
      "*://*.amazon.co.jp/*",
      "*://*.primevideo.com/*",
      "*://*.media-amazon.com/*",
      "*://*.pv-cdn.net/*",
      "*://*.aiv-cdn.net/*",
    ],
  },
);

chrome.runtime.onMessage.addListener((raw: ExtensionMessage, sender) => {
  if (raw.type === "CONTENT_READY") {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    const seen = urlsByTab.get(tabId);
    if (!seen) return;
    for (const url of seen) {
      const msg: SubtitleDetected = { type: "SUBTITLE_DETECTED", url };
      chrome.tabs.sendMessage(tabId, msg).catch(() => {});
    }
    return;
  }
  if (raw.type === "STATE_UPDATE") {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    applyBadge(tabId, raw.state);
    void applyIcon(tabId, raw.state);
    return;
  }
});

const STATUS_COLORS: Record<StateSnapshot["status"], string> = {
  idle: "#9ca3af",
  detected: "#d48a00",
  translating: "#1f6feb",
  ready: "#1a9b3f",
  error: "#b91c1c",
};

function drawIcon(size: number, color: string): ImageData {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable");
  const r = Math.max(2, Math.round(size * 0.22));
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, r);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = `bold ${Math.round(size * 0.7)}px "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("字", size / 2, size / 2 + Math.round(size * 0.04));
  return ctx.getImageData(0, 0, size, size);
}

function iconSet(color: string) {
  return {
    "16": drawIcon(16, color),
    "32": drawIcon(32, color),
    "48": drawIcon(48, color),
    "128": drawIcon(128, color),
  };
}

async function applyIcon(tabId: number, s: StateSnapshot) {
  await chrome.action
    .setIcon({ tabId, imageData: iconSet(STATUS_COLORS[s.status]) })
    .catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setIcon({ imageData: iconSet(STATUS_COLORS.idle) }).catch(() => {});
});

function applyBadge(tabId: number, s: StateSnapshot) {
  const action = chrome.action;
  if (s.status === "translating") {
    const p = s.progress;
    const pct = p && p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
    action.setBadgeBackgroundColor({ tabId, color: STATUS_COLORS.translating });
    action.setBadgeText({ tabId, text: `${pct}%` });
    return;
  }
  if (s.status === "error") {
    action.setBadgeBackgroundColor({ tabId, color: STATUS_COLORS.error });
    action.setBadgeText({ tabId, text: "!" });
    return;
  }
  action.setBadgeText({ tabId, text: "" });
}

// Clear tab state on full page load
chrome.tabs.onRemoved.addListener((tabId) => {
  urlsByTab.delete(tabId);
  lastTitleKeyByTab.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "loading") return;
  const url = info.url ?? tab.url;
  if (!url) {
    resetTab(tabId);
    return;
  }
  const key = titleKeyFromUrl(url);
  if (lastTitleKeyByTab.get(tabId) === key) return;
  lastTitleKeyByTab.set(tabId, key);
  resetTab(tabId);
});

// SPA navigation (pushState/replaceState) inside Prime Video — only reset if
// the title actually changed, since the player routinely rewrites the URL
// (ref= params, autoplay toggles) while the user keeps watching the same asin.
chrome.webNavigation.onHistoryStateUpdated.addListener(
  (details) => {
    if (details.frameId !== 0) return;
    const key = titleKeyFromUrl(details.url);
    if (lastTitleKeyByTab.get(details.tabId) === key) return;
    lastTitleKeyByTab.set(details.tabId, key);
    resetTab(details.tabId);
  },
  {
    url: [
      { hostContains: "amazon.com" },
      { hostContains: "amazon.co.jp" },
      { hostContains: "primevideo.com" },
    ],
  },
);
