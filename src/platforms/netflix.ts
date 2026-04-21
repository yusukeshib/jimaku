import { stripPromoCues } from "../lib/opensubtitles";
import { loadCues } from "../lib/subtitle";
import type { Cue, OpenSubtitlesFetch, OpenSubtitlesFetchResult } from "../types";
import type { Platform } from "./types";

const NETFLIX_HOSTS = ["*://*.netflix.com/*", "*://*.nflxvideo.net/*"] as const;

// Content script runs on /watch/<id> — that's the only page with the player.
const NETFLIX_CONTENT_MATCHES = ["*://*.netflix.com/watch/*"] as const;

// Host permissions for OpenSubtitles live on the Netflix platform because
// Netflix is the only platform that falls back to them. If more platforms
// start using OpenSubtitles these should move to a shared constant.
const OPENSUBTITLES_HOSTS = ["*://*.opensubtitles.org/*", "*://dl.opensubtitles.org/*"] as const;

const METADATA_URL_TEMPLATE =
  "/nq/website/memberapi/release/metadata?movieid={id}&imageFormat=webp&withSize=true&materialize=true";

type NetflixSeason = {
  seq: number;
  episodes?: Array<{ id?: number; episodeId?: number; seq?: number; title?: string }>;
};
type NetflixVideo = {
  title?: string;
  type?: "show" | "movie" | string;
  year?: number;
  currentEpisode?: number;
  seasons?: NetflixSeason[];
};

type ResolvedTitle = {
  /** Raw show/movie title. */
  title: string;
  /** TV season number (1-based) if this is an episode. */
  season?: number;
  /** TV episode number (1-based) if this is an episode. */
  episode?: number;
};

function videoIdFromLocation(): string | null {
  const m = window.location.pathname.match(/\/watch\/(\d+)/);
  return m ? m[1] : null;
}

let lastResolved: { videoId: string; resolved: ResolvedTitle } | null = null;

async function resolveTitle(videoId: string, signal?: AbortSignal): Promise<ResolvedTitle | null> {
  if (lastResolved && lastResolved.videoId === videoId) return lastResolved.resolved;
  const url = METADATA_URL_TEMPLATE.replace("{id}", videoId);
  const res = await fetch(url, { credentials: "include", signal });
  if (!res.ok) return null;
  const body = (await res.json()) as { video?: NetflixVideo };
  const v = body?.video;
  if (!v?.title) return null;

  const resolved: ResolvedTitle = { title: v.title };
  if (v.type === "show" && v.currentEpisode != null && v.seasons) {
    for (const season of v.seasons) {
      const ep = season.episodes?.find(
        (e) => e.id === v.currentEpisode || e.episodeId === v.currentEpisode,
      );
      if (ep) {
        resolved.season = season.seq;
        resolved.episode = ep.seq;
        break;
      }
    }
  }
  lastResolved = { videoId, resolved };
  return resolved;
}

function buildQuery(r: ResolvedTitle): string {
  if (r.season != null && r.episode != null) {
    const s = String(r.season).padStart(2, "0");
    const e = String(r.episode).padStart(2, "0");
    return `${r.title} S${s}E${e}`;
  }
  return r.title;
}

// Threshold for "usable" SRT — a real 20-min episode has hundreds of cues,
// but a tight threshold risks filtering short episodes. 50 is conservative.
const MIN_USABLE_CUES = 50;

async function fetchSrtViaBackground(query: string): Promise<string | null> {
  const msg: OpenSubtitlesFetch = {
    type: "OPENSUBTITLES_FETCH",
    query,
    language: "eng",
    minCues: MIN_USABLE_CUES,
  };
  const res: OpenSubtitlesFetchResult = await chrome.runtime.sendMessage(msg);
  if (!res?.ok) throw new Error(res?.error ?? "OpenSubtitles fetch failed");
  return res.srt;
}

async function fetchCues(videoId: string, signal?: AbortSignal): Promise<Cue[] | null> {
  const resolved = await resolveTitle(videoId, signal);
  if (!resolved) return null;
  const query = buildQuery(resolved);
  const srt = await fetchSrtViaBackground(query);
  if (!srt) return null;
  // No HLS on this path — fetcher is only used for HLS stitching which
  // doesn't apply to SRT.
  const parsed = await loadCues("", srt, () => Promise.reject(new Error("no fetcher")), signal);
  const cues = stripPromoCues(parsed);
  return cues.length > 0 ? cues : null;
}

export const netflix: Platform = {
  id: "netflix",

  matches(url: URL) {
    return /(^|\.)netflix\.com$/i.test(url.hostname);
  },

  hostPermissions: [...NETFLIX_HOSTS, ...OPENSUBTITLES_HOSTS],
  contentScriptMatches: NETFLIX_CONTENT_MATCHES,

  // Empty: Netflix delivers subtitles inside the encrypted MSL manifest, so
  // there's nothing useful to intercept at the network layer.
  webRequestUrls: [],

  webNavigationFilters: [{ hostContains: "netflix.com" }],

  titleKeyFromUrl(url: URL) {
    const m = url.pathname.match(/\/watch\/(\d+)/);
    return m ? `netflix:${m[1]}` : `netflix:${url.pathname}`;
  },

  // Netflix only mounts `.player-timedtext-text-container` while a cue is
  // on screen, so this selector may return null most frames. Callers
  // (overlay, calibration) already handle that.
  captionTextSelectors: [".player-timedtext-text-container"],

  // Hide both the outer wrapper and the inner text container so nothing
  // flashes through between cue mounts.
  captionHideSelectors: [".player-timedtext", ".player-timedtext-text-container"],

  findTitle() {
    const videoId = videoIdFromLocation();
    if (videoId && lastResolved?.videoId === videoId) {
      const r = lastResolved.resolved;
      if (r.season != null && r.episode != null) {
        return `${r.title} — S${r.season}E${r.episode}`;
      }
      return r.title;
    }
    // Pre-resolve: popup may display this before provide() has run.
    const t = document.title?.replace(/\s*[|–-]\s*Netflix\s*$/i, "").trim();
    return t || null;
  },

  subtitleSource: {
    kind: "provided",
    async provide(signal) {
      const videoId = videoIdFromLocation();
      if (!videoId) return null;
      const cues = await fetchCues(videoId, signal);
      if (!cues) return null;
      return { cacheKey: `netflix:${videoId}`, cues };
    },
  },
};
