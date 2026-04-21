import type { Platform } from "./types";

const PV_HOSTS = [
  "*://*.amazon.com/*",
  "*://*.amazon.co.jp/*",
  "*://*.primevideo.com/*",
  "*://*.media-amazon.com/*",
  "*://*.pv-cdn.net/*",
  "*://*.aiv-cdn.net/*",
] as const;

const PV_CONTENT_MATCHES = [
  "*://*.amazon.com/gp/video/*",
  "*://*.amazon.com/dp/*",
  "*://*.amazon.co.jp/gp/video/*",
  "*://*.amazon.co.jp/dp/*",
  "*://*.primevideo.com/*",
] as const;

const PV_HOST_RE = /(^|\.)(amazon\.com|amazon\.co\.jp|primevideo\.com)$/i;

export const primeVideo: Platform = {
  id: "primevideo",

  matches(url: URL) {
    return PV_HOST_RE.test(url.hostname);
  },

  hostPermissions: PV_HOSTS,
  contentScriptMatches: PV_CONTENT_MATCHES,

  webRequestUrls: PV_HOSTS,

  webNavigationFilters: [
    { hostContains: "amazon.com" },
    { hostContains: "amazon.co.jp" },
    { hostContains: "primevideo.com" },
  ],

  titleKeyFromUrl(url: URL) {
    const m = url.pathname.match(/\/(?:gp\/video\/detail|detail|dp)\/([A-Z0-9]+)/i);
    return m ? `${url.host}:${m[1]}` : `${url.host}${url.pathname}`;
  },

  captionTextSelectors: [
    ".atvwebplayersdk-captions-text",
    '.webPlayerSDKContainer [class*="caption"][class*="text"]',
  ],

  captionHideSelectors: [
    ".atvwebplayersdk-captions-overlay",
    ".atvwebplayersdk-captions-text",
    '.webPlayerSDKContainer [class*="captions"]',
  ],

  findTitle() {
    const sels = [
      ".atvwebplayersdk-title-text",
      '[class*="TitleContainer"] [class*="title"]',
      "h1",
    ];
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
  },

  subtitleSource: { kind: "network-intercept" },
};
