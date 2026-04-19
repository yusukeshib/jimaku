import type { Cue } from "../types";

const TIMESTAMP = /(\d{2,}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2,}):(\d{2}):(\d{2})[.,](\d{3})/;

function parseTs(h: string, m: string, s: string, ms: string): number {
  return +h * 3600 + +m * 60 + +s + +ms / 1000;
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, "").trim();
}

export function parseVtt(src: string): Cue[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const cues: Cue[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = TIMESTAMP.exec(line);
    if (!m) {
      i++;
      continue;
    }
    const start = parseTs(m[1], m[2], m[3], m[4]);
    const end = parseTs(m[5], m[6], m[7], m[8]);
    i++;
    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      textLines.push(lines[i]);
      i++;
    }
    const text = stripTags(textLines.join("\n"));
    if (text) cues.push({ start, end, text });
  }
  return cues;
}
