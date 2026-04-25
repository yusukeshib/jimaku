import { setProviderKey } from "./lib/cache";
import { connectOpenRouter } from "./lib/openrouterAuth";
import { allWebNavigationFilters, allWebRequestUrls, platformForUrl } from "./platforms";
import type {
  ExtensionMessage,
  OpenRouterConnectResult,
  StateSnapshot,
  SubtitleDetected,
  TabReset,
} from "./types";

const SUBTITLE_URL_RE = /\.(vtt|dfxp|ttml2?)(\?|$)/i;
const SUBTITLE_PATH_HINT = /(caption|subtitle|timedtext|subtitleset|-subs?-|_subs?_|\/subs\/)/i;
const HINTED_CONTAINER_RE = /\.(xml|json|m3u8)(\?|$)/i;
// Prime Video's DASH-segmented TTML subtitles live in fragmented MP4s named
// "{uuid}_text_{N}.mp4". No query-string extension hint — detect directly.
const DASH_TEXT_MP4_RE = /_text_\d+\.mp4(\?|$)/i;

const urlsByTab = new Map<number, Set<string>>();
const lastTitleKeyByTab = new Map<number, string>();

function titleKeyFromUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const platform = platformForUrl(parsed);
  if (platform) return platform.titleKeyFromUrl(parsed);
  return `${parsed.host}${parsed.pathname}`;
}

function looksLikeSubtitle(url: string): boolean {
  if (SUBTITLE_URL_RE.test(url)) return true;
  if (DASH_TEXT_MP4_RE.test(url)) return true;
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
  { urls: allWebRequestUrls() },
);

chrome.runtime.onMessage.addListener((raw: ExtensionMessage, sender, sendResponse) => {
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
  if (raw.type === "OPENROUTER_CONNECT") {
    // Handled in the SW so the flow survives the toolbar popup closing when
    // the OAuth window takes focus. The popup learns about success via
    // chrome.storage.onChanged (key land) and via this response (if still
    // open). Return true to keep the message channel open for the async
    // response.
    void (async () => {
      try {
        const key = await connectOpenRouter();
        await setProviderKey("openrouter", key);
        const res: OpenRouterConnectResult = { ok: true };
        sendResponse(res);
      } catch (e) {
        const res: OpenRouterConnectResult = {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
        sendResponse(res);
      }
    })();
    return true;
  }
});

// --- UI derivation (pure functions of state) ---

const ACTIVE_COLOR = "#1f6feb";
const ERROR_COLOR = "#b91c1c";
const SETUP_COLOR = "#d97706";
const DISABLED_COLOR = "#4b5563";
const IDLE_COLOR = "#9ca3af";

type IconSpec = { color: string; variant: "cc" | "dots" | "question" | "off" };
type BadgeSpec = { text: string; color: string } | null;

function deriveIcon(s: StateSnapshot): IconSpec {
  if (!s.enabled) return { color: DISABLED_COLOR, variant: "off" };
  if (!s.providerReady) return { color: SETUP_COLOR, variant: "question" };
  if (s.translation.phase === "error") return { color: ERROR_COLOR, variant: "cc" };
  // On a playback page (content script is live) with no subtitle URL yet
  // — show a loading "..." to signal "waiting to detect".
  if (s.translation.phase === "idle" && !s.hasSubtitle) {
    return { color: ACTIVE_COLOR, variant: "dots" };
  }
  return { color: ACTIVE_COLOR, variant: "cc" };
}

function deriveBadge(s: StateSnapshot): BadgeSpec {
  if (!s.enabled) return null;
  if (!s.providerReady) return { text: "!", color: SETUP_COLOR };
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
  if (spec.variant === "question") {
    ctx.font = `900 ${Math.round(size * 0.78)}px system-ui, -apple-system, "Helvetica Neue", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("?", size / 2, size / 2 + Math.round(size * 0.06));
    return ctx.getImageData(0, 0, size, size);
  }
  ctx.font = `900 ${Math.round(size * 0.55)}px system-ui, -apple-system, "Helvetica Neue", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("CC", size / 2, size / 2 + Math.round(size * 0.04));
  if (spec.variant === "off") {
    const pad = Math.round(size * 0.16);
    const stroke = Math.max(2, Math.round(size * 0.12));
    ctx.lineCap = "round";
    // Halo in the bg color so the slash reads cleanly over the CC glyphs.
    ctx.strokeStyle = spec.color;
    ctx.lineWidth = stroke + Math.max(2, Math.round(size * 0.06));
    ctx.beginPath();
    ctx.moveTo(pad, size - pad);
    ctx.lineTo(size - pad, pad);
    ctx.stroke();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = stroke;
    ctx.beginPath();
    ctx.moveTo(pad, size - pad);
    ctx.lineTo(size - pad, pad);
    ctx.stroke();
  }
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

function defaultIconSpec(enabled: boolean): IconSpec {
  return enabled ? { color: IDLE_COLOR, variant: "cc" } : { color: DISABLED_COLOR, variant: "off" };
}

function applyDefaultIcon(enabled: boolean) {
  chrome.action.setIcon({ imageData: iconSet(defaultIconSpec(enabled)) }).catch(() => {});
}

void chrome.storage.local.get("enabled").then((res) => {
  applyDefaultIcon(res.enabled !== false);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.enabled) return;
  applyDefaultIcon(changes.enabled.newValue !== false);
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

// SPA navigation inside a streaming platform — only reset on actual title change.
chrome.webNavigation.onHistoryStateUpdated.addListener(
  (details) => {
    if (details.frameId !== 0) return;
    const key = titleKeyFromUrl(details.url);
    if (lastTitleKeyByTab.get(details.tabId) === key) return;
    lastTitleKeyByTab.set(details.tabId, key);
    resetTab(details.tabId);
  },
  { url: allWebNavigationFilters() },
);
