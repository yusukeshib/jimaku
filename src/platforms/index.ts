import { netflix } from "./netflix";
import { primeVideo } from "./primevideo";
import type { Platform } from "./types";

export type { Platform, SubtitleSource } from "./types";

/** All registered platforms. Add new entries here to enable support. */
export const PLATFORMS: readonly Platform[] = [primeVideo, netflix];

/** Pick the platform that owns `url`, or null if none match. */
export function platformForUrl(url: string | URL): Platform | null {
  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url) : url;
  } catch {
    return null;
  }
  for (const p of PLATFORMS) {
    if (p.matches(parsed)) return p;
  }
  return null;
}

/**
 * Resolve the platform for the current page (content script only — reads
 * `window.location`). Cached because the host can't change within a single
 * content-script lifetime.
 */
let cachedCurrentPlatform: Platform | null | undefined;
export function currentPlatform(): Platform | null {
  if (cachedCurrentPlatform !== undefined) return cachedCurrentPlatform;
  cachedCurrentPlatform = platformForUrl(window.location.href);
  return cachedCurrentPlatform;
}

/** Aggregate all platforms' manifest `host_permissions`. */
export function allHostPermissions(): string[] {
  return dedupe(PLATFORMS.flatMap((p) => [...p.hostPermissions]));
}

/** Aggregate all platforms' manifest `content_scripts.matches`. */
export function allContentScriptMatches(): string[] {
  return dedupe(PLATFORMS.flatMap((p) => [...p.contentScriptMatches]));
}

/** Aggregate all platforms' webRequest URL patterns. */
export function allWebRequestUrls(): string[] {
  return dedupe(PLATFORMS.flatMap((p) => [...p.webRequestUrls]));
}

/** Aggregate all platforms' webNavigation filter specs. */
export function allWebNavigationFilters(): chrome.events.UrlFilter[] {
  return PLATFORMS.flatMap((p) => [...p.webNavigationFilters]);
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
