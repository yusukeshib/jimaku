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

// --- UI derivation (pure functions of state) ---

const ACTIVE_COLOR = "#1f6feb";
const ERROR_COLOR = "#b91c1c";
const DISABLED_COLOR = "#4b5563";
const IDLE_COLOR = "#9ca3af";

type IconSpec = { color: string; variant: "cc" | "dots" };
type BadgeSpec = { text: string; color: string } | null;

function deriveIcon(s: StateSnapshot): IconSpec {
  if (!s.enabled) return { color: DISABLED_COLOR, variant: "cc" };
  if (s.translation.phase === "error") return { color: ERROR_COLOR, variant: "cc" };
  // On a Prime Video page (content script is live) with no subtitle URL yet
  // — show a loading "..." to signal "waiting to detect".
  if (s.translation.phase === "idle" && !s.hasSubtitle) {
    return { color: ACTIVE_COLOR, variant: "dots" };
  }
  return { color: ACTIVE_COLOR, variant: "cc" };
}

function deriveBadge(s: StateSnapshot): BadgeSpec {
  if (!s.enabled) return null;
  if (s.translation.phase === "translating") {
    const p = s.translation.progress;
    const pct = p && p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
    return { text: `${pct}%`, color: ACTIVE_COLOR };
  }
  if (s.translation.phase === "complete" && s.playback !== "absent") {
    return { text: "100%", color: ACTIVE_COLOR };
  }
  if (s.translation.phase === "error") return { text: "!", color: ERROR_COLOR };
  return null;
}

// --- Icon drawing ---

function drawIcon(size: number, spec: IconSpec): ImageData {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable");
  const r = Math.max(2, Math.round(size * 0.22));
  ctx.fillStyle = spec.color;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, r);
  ctx.fill();
  ctx.fillStyle = "#fff";
  if (spec.variant === "dots") {
    const dotR = Math.max(2, Math.round(size * 0.12));
    const gap = dotR * 3;
    const cy = size / 2;
    const cx = size / 2;
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.arc(cx + i * gap, cy, dotR, 0, Math.PI * 2);
      ctx.fill();
    }
    return ctx.getImageData(0, 0, size, size);
  }
  ctx.font = `900 ${Math.round(size * 0.55)}px system-ui, -apple-system, "Helvetica Neue", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("CC", size / 2, size / 2 + Math.round(size * 0.04));
  return ctx.getImageData(0, 0, size, size);
}

function iconSet(spec: IconSpec) {
  return {
    "16": drawIcon(16, spec),
    "32": drawIcon(32, spec),
    "48": drawIcon(48, spec),
    "128": drawIcon(128, spec),
  };
}

async function applyIcon(tabId: number, s: StateSnapshot) {
  await chrome.action.setIcon({ tabId, imageData: iconSet(deriveIcon(s)) }).catch(() => {});
}

function applyBadge(tabId: number, s: StateSnapshot) {
  const spec = deriveBadge(s);
  if (!spec) {
    chrome.action.setBadgeText({ tabId, text: "" });
    return;
  }
  chrome.action.setBadgeBackgroundColor({ tabId, color: spec.color });
  chrome.action.setBadgeText({ tabId, text: spec.text });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.action
    .setIcon({ imageData: iconSet({ color: IDLE_COLOR, variant: "cc" }) })
    .catch(() => {});
});

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

// SPA navigation inside Prime Video — only reset on actual title change.
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
