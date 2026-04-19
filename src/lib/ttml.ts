import type { Cue } from "../types";

const CLOCK_TIME = /^(\d+):(\d{2}):(\d{2})(?:[.,](\d+))?$/;
const OFFSET_TIME = /^(\d+(?:\.\d+)?)(h|m|s|ms|f|t)$/;

function parseTime(raw: string | null, tickRate: number, frameRate: number): number | null {
  if (!raw) return null;
  const s = raw.trim();
  const clock = CLOCK_TIME.exec(s);
  if (clock) {
    const [, h, m, sec, frac] = clock;
    const fraction = frac ? Number(`0.${frac}`) : 0;
    return +h * 3600 + +m * 60 + +sec + fraction;
  }
  const offset = OFFSET_TIME.exec(s);
  if (offset) {
    const n = Number(offset[1]);
    switch (offset[2]) {
      case "h":
        return n * 3600;
      case "m":
        return n * 60;
      case "s":
        return n;
      case "ms":
        return n / 1000;
      case "f":
        return frameRate > 0 ? n / frameRate : 0;
      case "t":
        return tickRate > 0 ? n / tickRate : 0;
    }
  }
  return null;
}

function extractText(node: Node): string {
  let out = "";
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.textContent ?? "";
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      const tag = el.localName.toLowerCase();
      if (tag === "br") {
        out += "\n";
      } else {
        out += extractText(el);
      }
    }
  }
  return out;
}

function collapseWhitespace(s: string): string {
  return s
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

export function parseTtml(src: string): Cue[] {
  const doc = new DOMParser().parseFromString(src, "application/xml");
  const parserError = doc.getElementsByTagName("parsererror")[0];
  if (parserError) throw new Error("Failed to parse TTML");

  const root = doc.documentElement;
  const tickRate = Number(root.getAttribute("ttp:tickRate") ?? "0") || 0;
  const frameRate = Number(root.getAttribute("ttp:frameRate") ?? "0") || 0;

  const paragraphs = Array.from(doc.getElementsByTagName("*")).filter(
    (el) => el.localName.toLowerCase() === "p",
  );

  const cues: Cue[] = [];
  for (const p of paragraphs) {
    const start = parseTime(p.getAttribute("begin"), tickRate, frameRate);
    const end = parseTime(p.getAttribute("end"), tickRate, frameRate);
    if (start === null || end === null) continue;
    const text = collapseWhitespace(extractText(p));
    if (text) cues.push({ start, end, text });
  }
  return cues;
}
