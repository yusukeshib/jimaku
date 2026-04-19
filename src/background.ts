import type { SubtitleDetected } from "./types";

const SUBTITLE_URL_RE = /\.(vtt|dfxp|ttml2?)(\?|$)/i;
const SUBTITLE_PATH_HINT = /(caption|subtitle|timedtext)/i;

const seenByTab = new Map<number, Set<string>>();

function looksLikeSubtitle(url: string): boolean {
  if (SUBTITLE_URL_RE.test(url)) return true;
  if (SUBTITLE_PATH_HINT.test(url) && /\.(xml|json)(\?|$)/i.test(url)) return true;
  return false;
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (!looksLikeSubtitle(details.url)) return;

    let seen = seenByTab.get(details.tabId);
    if (!seen) {
      seen = new Set();
      seenByTab.set(details.tabId, seen);
    }
    if (seen.has(details.url)) return;
    seen.add(details.url);

    const msg: SubtitleDetected = { type: "SUBTITLE_DETECTED", url: details.url };
    chrome.tabs.sendMessage(details.tabId, msg).catch(() => {
      // content script not ready yet; ignore
    });
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

chrome.tabs.onRemoved.addListener((tabId) => {
  seenByTab.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading" && info.url) {
    seenByTab.delete(tabId);
  }
});
