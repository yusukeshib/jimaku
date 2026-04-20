import type { Cue, TranslatedCue } from "../types";

export const MODEL = "claude-opus-4-7";
export const TARGET_LANGUAGE = "Japanese";
const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const CHUNK_SIZE = 50;
const MAX_TOKENS = 8000;
const MAX_ATTEMPTS = 4;

const SYSTEM_PROMPT = `You are a film subtitle translator. Translate the source subtitles into natural ${TARGET_LANGUAGE} subtitles that read like a professionally authored native-${TARGET_LANGUAGE} track — not a literal gloss of the source.

About the input:
- Each <line> carries start/end seconds from the source subtitle track. The player uses whatever start/end you put on each output cue to decide when to show it, so your output timestamps are the ground truth downstream.

Translation approach:
- Render proper nouns using established ${TARGET_LANGUAGE} forms when they exist; otherwise follow ${TARGET_LANGUAGE}'s normal transliteration conventions.
- Match the tone, register, and character voice of the source.
- Prefer the phrasing a native ${TARGET_LANGUAGE} viewer would expect over a word-for-word rendering.
- For unfamiliar proper nouns or specialized terms, use whatever annotation convention native ${TARGET_LANGUAGE} subtitle tracks use (ruby / furigana, transliteration, italics, nothing at all). Apply it sparingly — only where a native viewer would want the help.

${TARGET_LANGUAGE} punctuation:
- Use ${TARGET_LANGUAGE}'s native punctuation conventions throughout. Do not leave ASCII punctuation where ${TARGET_LANGUAGE} has native forms (e.g. full-width for Japanese, \`¿¡\` for Spanish, guillemets for French, etc.).

Cue restructuring is expected, not optional:
Professional native-${TARGET_LANGUAGE} subtitle tracks regularly split one source cue into 2–3 shorter cues when the source cue would otherwise be too long, cross a clause boundary, or span a natural breath break. You should do the same. Split a source cue into multiple output cues when any of the following holds:
  - The ${TARGET_LANGUAGE} rendering would be awkwardly long for a single cue (follow ${TARGET_LANGUAGE}'s reading-speed norms).
  - The source cue spans a clause boundary — a comma, a line break (shown as \` / \`), or a connector ("and" / "but" / "then" / "because").
  - The speaker changes, or the topic shifts, within a single source cue.

When splitting:
  - Allocate time proportionally to where the split falls in the source (a mid-sentence comma near 50% → cue boundary near 50%). A line break is a strong split signal.
  - Each sub-cue is a single short breath unit.
  - For cross-cue continuation of a single sentence, use ${TARGET_LANGUAGE}'s native convention (whether that's an em-dash, ellipsis, specific punctuation, or nothing). Non-final sub-cues take no terminal punctuation; the final sub-cue takes its normal closing punctuation.

You may also merge tightly-spaced source cues into one when the combined rendering reads as a single short breath. Each output cue's start/end must fall within the overall time range of the source cues in this batch; cues must be in chronological order and must not overlap.

Use cue spacing as a tonal signal: short gap (< 1s) = rapid dialogue, crisp phrasing; long gap (> 5s) = monologue/narration, calmer phrasing.

Non-dialogue markers:
- If a cue is clearly non-dialogue narration (opening exposition, scene-setting voice-over) and ${TARGET_LANGUAGE} has a conventional marker for that, apply it to the FIRST cue of the narration passage only (not every cue).

Cues to SKIP entirely (emit ZERO <line> tags for these; do not emit any placeholder, empty tag, or text like "(no subtitle)"):
- Legal disclaimers shown at episode openings (e.g. "Fictional work. Any similarity to real names or events is coincidental.", "Underage smoking is prohibited.", studio logos).
- Visual-only on-screen text cards that are NOT spoken: all-caps location labels (e.g. "TOKYO STATION"), character-name / age title cards (e.g. "NAME / AGE 15"), time-skip captions ("A FEW DAYS LATER"), and similar chyrons. Native subtitle tracks omit these because viewers read them directly from the video.
- DO translate episode / chapter titles when they appear as subtitle cues (e.g. "EPISODE 1: AN OATH FOR PEACE").

I/O format:
- Input: a sequence of <line i="N" start="SEC" end="SEC">source</line>. The index N is only so you can refer back — do not echo it in the output.
- Output: a sequence of <line start="SEC" end="SEC">${TARGET_LANGUAGE}</line>. Use seconds with up to 3 decimal places.
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

type ParsedLine = { start: number; end: number; ja: string };

function parseTimeValue(s: string): number {
  const v = Number(s);
  if (Number.isFinite(v)) return v;
  // Accept clock-time style HH:MM:SS(.fff) in case the model ignores our "seconds" instruction.
  const m = s.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number.NaN;
}

function parseOutput(raw: string): ParsedLine[] {
  // Match <line ...>text</line>, attribute order agnostic.
  const re = /<line\s+([^>]*?)>([\s\S]*?)<\/line>/g;
  const attrRe = /(\w+)\s*=\s*"([^"]*)"/g;
  const out: ParsedLine[] = [];
  for (const m of raw.matchAll(re)) {
    const attrs: Record<string, string> = {};
    for (const a of m[1].matchAll(attrRe)) attrs[a[1]] = a[2];
    const start = parseTimeValue(attrs.start ?? "");
    const end = parseTimeValue(attrs.end ?? "");
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const ja = unescapeXml(m[2]).trim();
    if (!ja) continue;
    out.push({ start, end, ja });
  }
  if (out.length === 0) throw new Error("No <line> tags with start/end found in model response");
  return out;
}

function sanitizeChunkOutput(
  parsed: ParsedLine[],
  chunkStart: number,
  chunkEnd: number,
): TranslatedCue[] {
  const clamped: TranslatedCue[] = [];
  for (const p of parsed) {
    const start = Math.max(chunkStart, Math.min(chunkEnd, p.start));
    const end = Math.max(start + 0.001, Math.min(chunkEnd, p.end));
    clamped.push({ start, end, ja: p.ja });
  }
  clamped.sort((a, b) => a.start - b.start);
  // Collapse any residual overlap so downstream binary-search returns a single cue per time.
  for (let i = 1; i < clamped.length; i++) {
    if (clamped[i].start < clamped[i - 1].end) {
      clamped[i - 1].end = clamped[i].start;
    }
  }
  return clamped.filter((c) => c.end > c.start);
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
  const result: TranslatedCue[] = [];
  let done = 0;
  let prevContext: string | null = null;

  for (const c of chunks) {
    if (signal?.aborted) throw new AbortError();
    const chunkStart = c[0].start;
    const chunkEnd = c[c.length - 1].end;
    const userContent = serializeInput(c);

    try {
      const raw = await callClaudeWithRetry(apiKey, userContent, prevContext, signal);
      const parsed = parseOutput(raw);
      const sanitized = sanitizeChunkOutput(parsed, chunkStart, chunkEnd);
      if (sanitized.length === 0) throw new Error("chunk produced no valid cues");
      result.push(...sanitized);
      prevContext = sanitized
        .slice(-5)
        .map((p) => p.ja)
        .join("\n");
    } catch (e) {
      if (e instanceof AbortError || (e as Error).name === "AbortError") throw e;
      // Preserve source cues unchanged so the track stays watchable even if a
      // single chunk fails after retries.
      for (const src of c) {
        result.push({ start: src.start, end: src.end, ja: src.t });
      }
    }

    done += c.length;
    onProgress?.(done, cues.length);
  }

  return result.sort((a, b) => a.start - b.start);
}

export { AbortError };
