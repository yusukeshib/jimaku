import type { Cue } from "../types";

/**
 * How a platform delivers subtitle cues to us.
 *
 *   - `network-intercept`: the player loads a public subtitle file (VTT, TTML,
 *     HLS-of-VTT) via a normal HTTP request. The background watches those
 *     requests and pushes URLs to the content script, which fetches and parses
 *     the file. Used by Prime Video.
 *
 *   - `provided`: we can't observe the subtitle file on the wire (e.g. Netflix
 *     bundles cues inside an MSL-encrypted manifest). The platform supplies
 *     cues itself — typically by looking up a public source like OpenSubtitles
 *     keyed on the current title/episode. `provide()` returns a stable
 *     `cacheKey` (used in lieu of a URL for the translation cache) plus the
 *     parsed cues, or `null` if no source is available.
 */
export type SubtitleSource =
  | { readonly kind: "network-intercept" }
  | {
      readonly kind: "provided";
      provide(signal?: AbortSignal): Promise<{ cacheKey: string; cues: Cue[] } | null>;
    };

/**
 * Abstraction over a streaming platform (Prime Video, Netflix, …).
 *
 * The extension is platform-aware in three places:
 *   - Manifest: which hosts we request permission for, which URLs mount the
 *     content script.
 *   - Background: which hosts we watch for subtitle requests, which SPA
 *     navigation events reset tab state, and how to derive a per-title key
 *     so in-episode history-state updates don't wipe translation state.
 *   - Content script: which native caption element to observe / hide, and
 *     how to pull a human-readable title from the DOM.
 *
 * A `Platform` bundles all of that for one service so adding a new service
 * is a single-file change.
 */
export interface Platform {
  /** Stable identifier (e.g. "primevideo"). Used in logs, not for matching. */
  readonly id: string;

  /** True if this URL belongs to the platform. Called with the page URL. */
  matches(url: URL): boolean;

  // === Manifest ===

  /** `host_permissions` entries contributed by this platform. */
  readonly hostPermissions: readonly string[];

  /** `content_scripts.matches` entries contributed by this platform. */
  readonly contentScriptMatches: readonly string[];

  // === Background ===

  /** URL patterns for `chrome.webRequest` subtitle interception. */
  readonly webRequestUrls: readonly string[];

  /** Filters for `chrome.webNavigation.onHistoryStateUpdated`. */
  readonly webNavigationFilters: readonly chrome.events.UrlFilter[];

  /**
   * Stable per-title key used to detect *actual* title changes across SPA
   * navigations. Two URLs within the same episode/movie should return the
   * same key so translation state survives in-page navigation.
   */
  titleKeyFromUrl(url: URL): string;

  // === Content script ===

  /** CSS selectors for the native caption text element, priority order. */
  readonly captionTextSelectors: readonly string[];

  /** CSS selectors that get `visibility: hidden` when hiding native captions. */
  readonly captionHideSelectors: readonly string[];

  /** Extract the current title from the DOM, or null if unavailable. */
  findTitle(): string | null;

  /** How this platform delivers subtitle cues (see {@link SubtitleSource}). */
  readonly subtitleSource: SubtitleSource;
}
