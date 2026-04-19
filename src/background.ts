import type { ExtensionMessage, SubtitleDetected, TabReset } from "./types";

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
  if (raw.type !== "CONTENT_READY") return;
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;
  const seen = urlsByTab.get(tabId);
  if (!seen) return;
  for (const url of seen) {
    const msg: SubtitleDetected = { type: "SUBTITLE_DETECTED", url };
    chrome.tabs.sendMessage(tabId, msg).catch(() => {});
  }
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
