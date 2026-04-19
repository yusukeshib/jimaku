import type { Cue } from "../types";
import { parseVtt } from "./vtt";

const EXTINF_RE = /^#EXTINF:([\d.]+)/;
const TIMESTAMP_MAP_RE = /^WEBVTT[^\n]*\n(?:[^\n]*\n)*?X-TIMESTAMP-MAP=([^\n]+)/i;
const CONCURRENCY = 6;

type Segment = { url: string; duration: number };

function parsePlaylist(playlistUrl: string, src: string): Segment[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: Segment[] = [];
  let pendingDuration: number | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF")) {
      const m = EXTINF_RE.exec(line);
      pendingDuration = m ? Number(m[1]) : 0;
      continue;
    }
    if (line.startsWith("#")) continue;
    const url = new URL(line, playlistUrl).href;
    out.push({ url, duration: pendingDuration ?? 0 });
    pendingDuration = null;
  }
  return out;
}

function parseTimestampMapOffset(vttText: string): number | null {
  const m = TIMESTAMP_MAP_RE.exec(vttText);
  if (!m) return null;
  const attrs = m[1];
  const mpegts = /MPEGTS:(\d+)/.exec(attrs);
  const local = /LOCAL:(\d+):(\d{2}):(\d{2})(?:[.,](\d+))?/.exec(attrs);
  if (!mpegts) return null;
  const mpegtsSec = Number(mpegts[1]) / 90000;
  let localSec = 0;
  if (local) {
    const frac = local[4] ? Number(`0.${local[4]}`) : 0;
    localSec = +local[1] * 3600 + +local[2] * 60 + +local[3] + frac;
  }
  return mpegtsSec - localSec;
}

async function withConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, idx: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function runner() {
    while (true) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

export async function fetchAndStitchHlsVtt(
  playlistUrl: string,
  playlistText: string,
  fetcher: (url: string, signal?: AbortSignal) => Promise<string>,
  signal?: AbortSignal,
): Promise<Cue[]> {
  const segments = parsePlaylist(playlistUrl, playlistText);
  if (segments.length === 0) throw new Error("No segments found in m3u8 playlist");

  // Precompute cumulative EXTINF-based offsets as fallback
  const fallbackOffsets: number[] = [];
  {
    let acc = 0;
    for (const seg of segments) {
      fallbackOffsets.push(acc);
      acc += seg.duration;
    }
  }

  const texts = await withConcurrency(
    segments,
    CONCURRENCY,
    (seg) => fetcher(seg.url, signal),
    signal,
  );

  const all: Cue[] = [];
  for (let i = 0; i < segments.length; i++) {
    const text = texts[i];
    const offsetFromMap = parseTimestampMapOffset(text);
    const offset = offsetFromMap ?? fallbackOffsets[i];
    const cues = parseVtt(text);
    for (const c of cues) {
      all.push({ start: c.start + offset, end: c.end + offset, text: c.text });
    }
  }

  all.sort((a, b) => a.start - b.start);
  // de-dup overlapping identical cues (some HLS subtitle segments overlap at boundaries)
  const dedup: Cue[] = [];
  for (const c of all) {
    const last = dedup[dedup.length - 1];
    if (last && last.text === c.text && Math.abs(last.start - c.start) < 0.05) continue;
    dedup.push(c);
  }
  return dedup;
}
