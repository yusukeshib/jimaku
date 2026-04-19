import type { ExtensionMessage, SubtitleDetected, TabReset } from "./types";

const SUBTITLE_URL_RE = /\.(vtt|dfxp|ttml2?)(\?|$)/i;
const SUBTITLE_PATH_HINT = /(caption|subtitle|timedtext|subtitleset)/i;

const urlsByTab = new Map<number, Set<string>>();

function looksLikeSubtitle(url: string): boolean {
  if (SUBTITLE_URL_RE.test(url)) return true;
  if (SUBTITLE_PATH_HINT.test(url) && /\.(xml|json)(\?|$)/i.test(url)) return true;
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
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") resetTab(tabId);
});

// SPA navigation (pushState/replaceState) inside Prime Video
chrome.webNavigation.onHistoryStateUpdated.addListener(
  (details) => {
    if (details.frameId !== 0) return;
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
