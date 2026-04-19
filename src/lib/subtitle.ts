import type { Cue } from "../types";
import { fetchAndStitchHlsVtt } from "./m3u8";
import { parseTtml } from "./ttml";
import { parseVtt } from "./vtt";

export type SubtitleFormat = "vtt" | "ttml" | "hls" | "unknown";

export function sniffFormat(text: string): SubtitleFormat {
  const head = text.slice(0, 512).trimStart();
  if (head.startsWith("#EXTM3U")) return "hls";
  if (/^WEBVTT/.test(head)) return "vtt";
  if (head.startsWith("<") && /<(tt|tt:tt|smpte)\b/i.test(head)) return "ttml";
  if (head.startsWith("<?xml")) return "ttml";
  return "unknown";
}

export type FetchFn = (url: string, signal?: AbortSignal) => Promise<string>;

export async function loadCues(
  url: string,
  text: string,
  fetcher: FetchFn,
  signal?: AbortSignal,
): Promise<Cue[]> {
  const format = sniffFormat(text);
  switch (format) {
    case "vtt":
      return parseVtt(text);
    case "ttml":
      return parseTtml(text);
    case "hls":
      return await fetchAndStitchHlsVtt(url, text, fetcher, signal);
    default:
      throw new Error(
        `Could not detect subtitle format (head: ${text.slice(0, 40).replace(/\n/g, " ")})`,
      );
  }
}
