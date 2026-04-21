/**
 * OpenSubtitles.org client — HTML-scraping fallback that needs no API key.
 *
 * Search flow:
 *   1. GET /en/search/sublanguageid-<lang>/moviename-<query> → HTML with a
 *      table of sub IDs.
 *   2. GET /en/subtitles/<subId>/... → sub detail page with a ZIP download URL.
 *   3. GET dl.opensubtitles.org/en/download/sub/<subId> → ZIP archive with
 *      one SRT file inside.
 *
 * This is brittle by nature (HTML can change) but works today and requires
 * zero user setup. We can swap to the authenticated REST API later if
 * scraping breaks.
 */

import type { Cue } from "../types";
import { extractFirstEntryAsText } from "./zip";

const SEARCH_ORIGIN = "https://www.opensubtitles.org";
const DOWNLOAD_ORIGIN = "https://dl.opensubtitles.org";

export type OpenSubtitlesQuery = {
  /** Free-text title query. For TV, caller should append "S01E01". */
  query: string;
  /** ISO 639-2/T language code, e.g. "eng", "spa". Defaults to "eng". */
  language?: string;
};

/**
 * Search OpenSubtitles and return the subtitle IDs from the first result page,
 * most-downloaded first (which is the site's default sort).
 */
export async function searchSubtitleIds(
  q: OpenSubtitlesQuery,
  signal?: AbortSignal,
): Promise<string[]> {
  const lang = q.language ?? "eng";
  const url = `${SEARCH_ORIGIN}/en/search/sublanguageid-${encodeURIComponent(
    lang,
  )}/moviename-${encodeURIComponent(q.query)}`;
  const res = await fetch(url, { credentials: "include", signal });
  if (!res.ok) throw new Error(`OpenSubtitles search failed: ${res.status}`);
  const html = await res.text();

  // Each result row links to /en/subtitles/<id>/<slug>.
  const ids: string[] = [];
  const seen = new Set<string>();
  const re = /\/en\/subtitles\/(\d+)\//g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic for regex loop
  while ((m = re.exec(html)) !== null) {
    const id = m[1];
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Download a subtitle file by ID and return the raw text (SRT).
 *
 * The `/download/sub/<id>` endpoint returns a ZIP with a single .srt inside.
 * We unpack and decode in-browser.
 */
export async function downloadSubtitleText(subId: string, signal?: AbortSignal): Promise<string> {
  const url = `${DOWNLOAD_ORIGIN}/en/download/sub/${encodeURIComponent(subId)}`;
  const res = await fetch(url, { credentials: "include", signal });
  if (!res.ok) throw new Error(`OpenSubtitles download failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  const u8 = new Uint8Array(buf);
  // A few entries are served as raw .srt rather than zipped. Detect by PK magic.
  const isZip = u8[0] === 0x50 && u8[1] === 0x4b;
  if (!isZip) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(u8);
    } catch {
      return new TextDecoder("latin1").decode(u8);
    }
  }
  return await extractFirstEntryAsText(u8);
}

/**
 * OpenSubtitles uploads often carry promotional or credit cues that aren't
 * part of the actual dialogue. Drop them before translation so we don't waste
 * API calls on junk (and so the user doesn't see "Support us and become
 * VIP member" in Japanese on their screen).
 */
const PROMO_PATTERNS: readonly RegExp[] = [
  /opensubtitles\.(?:org|com|net)/i,
  /\bbecome\s+(?:a\s+)?vip\s+member/i,
  /\bremove\s+all\s+ads\b/i,
  /\btranscript\s*(?:&|and)?\s*synch?\b/i,
  /\bsub(?:titles|bed|s)\s+by\b/i,
  /\bsynchroni[sz]ed\s+by\b/i,
  /\btranslated\s+by\b/i,
];

export function stripPromoCues(cues: Cue[]): Cue[] {
  return cues.filter((c) => !PROMO_PATTERNS.some((re) => re.test(c.text)));
}

/**
 * Try each ID in order until one returns non-trivial SRT. "Non-trivial" means
 * at least a handful of cues — the site has stub uploads with 1–3 cues that
 * are useless for us.
 */
export async function findFirstUsableSubtitle(
  ids: string[],
  minCues: number,
  signal?: AbortSignal,
): Promise<string | null> {
  for (const id of ids) {
    try {
      const text = await downloadSubtitleText(id, signal);
      const cueCount = (text.match(/-->/g) ?? []).length;
      if (cueCount >= minCues) return text;
    } catch {
      // Skip this one, try the next.
    }
  }
  return null;
}
