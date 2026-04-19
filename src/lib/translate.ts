import type { Cue, TranslatedCue } from "../types";

export const MODEL = "claude-opus-4-7";
export const TARGET_LANGUAGE = "Japanese";
const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const CHUNK_SIZE = 50;
const MAX_TOKENS = 8000;
const MAX_ATTEMPTS = 4;

const SYSTEM_PROMPT = `You are a film subtitle translator. Translate the source subtitles into natural, concise ${TARGET_LANGUAGE} subtitles.

Rules:
- Keep each line short enough to read quickly; insert a line break if it would otherwise be too long on screen.
- Render proper nouns in the target language's native script; follow established translations when they exist.
- Match the tone to the work's mood and each character's voice.
- Use the target language's native punctuation conventions.
- Consider each cue's start/end and the gap to adjacent cues when choosing pacing and tone:
  - Short gap (< 1s) = rapid dialogue; crisp, clipped phrasing.
  - Long gap (> 5s) = monologue / narration; calmer phrasing.
- One input cue maps to exactly one output line. Do not merge or split cues.

I/O format:
- Input: a sequence of <line i="N" start="SEC" end="SEC">source</line>.
- Output: a sequence of <line i="N">${TARGET_LANGUAGE}</line> (do NOT echo start/end).
- The index N must match the input exactly.
- Output only <line> tags — no preamble, no code fences, no commentary.`;

type Progress = (done: number, total: number) => void;

type AnthropicContentBlock = { type: string; text?: string };
type AnthropicResponse = { content?: AnthropicContentBlock[] };

export type TranslateOptions = {
  signal?: AbortSignal;
  onProgress?: Progress;
};

class AbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function serializeInput(
  items: Array<{ i: number; start: number; end: number; t: string }>,
): string {
  return items
    .map(
      (x) =>
        `<line i="${x.i}" start="${x.start.toFixed(2)}" end="${x.end.toFixed(2)}">${escapeXml(x.t)}</line>`,
    )
    .join("\n");
}

function parseOutput(raw: string): Array<{ i: number; ja: string }> {
  const re = /<line\s+i="(\d+)"\s*>([\s\S]*?)<\/line>/g;
  const out: Array<{ i: number; ja: string }> = [];
  for (const m of raw.matchAll(re)) {
    out.push({ i: Number(m[1]), ja: unescapeXml(m[2]).trim() });
  }
  if (out.length === 0) throw new Error("No <line> tags found in model response");
  return out;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function callClaudeOnce(
  apiKey: string,
  userContent: string,
  prevContext: string | null,
  signal?: AbortSignal,
): Promise<string> {
  const messages: Array<{ role: string; content: string }> = [];
  if (prevContext) {
    messages.push({
      role: "user",
      content: `Reference: translations from the previous chunk. Use them only for context and tonal consistency; do NOT retranslate them here.\n${prevContext}`,
    });
    messages.push({ role: "assistant", content: "Understood. Waiting for the next chunk." });
  }
  messages.push({ role: "user", content: userContent });

  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: 0.3,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages,
  };

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": API_VERSION,
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const err = await res.text();
    const e = new Error(`Claude API ${res.status}: ${err}`);
    (e as Error & { status?: number }).status = res.status;
    throw e;
  }
  const data = (await res.json()) as AnthropicResponse;
  const text = data.content?.find((c) => c.type === "text")?.text;
  if (!text) throw new Error("empty response from Claude");
  return text;
}

function isRetryable(err: unknown): boolean {
  if (err instanceof AbortError) return false;
  const status = (err as { status?: number }).status;
  if (status === undefined) return true; // network / parse errors
  return status === 429 || status >= 500;
}

async function callClaudeWithRetry(
  apiKey: string,
  userContent: string,
  prevContext: string | null,
  signal?: AbortSignal,
): Promise<string> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new AbortError();
    try {
      return await callClaudeOnce(apiKey, userContent, prevContext, signal);
    } catch (e) {
      lastErr = e;
      if (!isRetryable(e) || attempt === MAX_ATTEMPTS - 1) throw e;
      const backoff = Math.min(30000, 1000 * 2 ** attempt) + Math.random() * 500;
      await sleep(backoff, signal);
    }
  }
  throw lastErr;
}

export async function translateCues(
  cues: Cue[],
  apiKey: string,
  opts: TranslateOptions = {},
): Promise<TranslatedCue[]> {
  const { signal, onProgress } = opts;
  const indexed = cues.map((c, i) => ({ i, start: c.start, end: c.end, t: c.text }));
  const chunks = chunk(indexed, CHUNK_SIZE);
  const result: TranslatedCue[] = new Array(cues.length);
  let done = 0;
  let prevContext: string | null = null;

  for (const c of chunks) {
    if (signal?.aborted) throw new AbortError();
    const userContent = serializeInput(c);
    const raw = await callClaudeWithRetry(apiKey, userContent, prevContext, signal);
    const parsed = parseOutput(raw);

    for (const item of parsed) {
      const original = cues[item.i];
      if (!original) continue;
      result[item.i] = { start: original.start, end: original.end, ja: item.ja };
    }

    prevContext = parsed
      .slice(-5)
      .map((p) => p.ja)
      .join("\n");

    done += c.length;
    onProgress?.(done, cues.length);
  }

  for (let i = 0; i < cues.length; i++) {
    if (!result[i]) {
      result[i] = { start: cues[i].start, end: cues[i].end, ja: cues[i].text };
    }
  }
  return result;
}

export { AbortError };
