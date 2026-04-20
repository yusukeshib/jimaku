import type { Cue, TranslatedCue } from "../types";

export const MODEL = "claude-opus-4-7";
const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const MAX_TOKENS = 32000;
const MAX_ATTEMPTS = 4;

function buildSystemPrompt(lang: string): string {
  return `You are a film subtitle translator. Translate the source subtitles into natural ${lang} subtitles that read like a professionally authored native-${lang} track — not a literal gloss of the source.

About the input:
- Each <line> carries start/end seconds from the source subtitle track. The player uses whatever start/end you put on each output cue to decide when to show it, so your output timestamps are the ground truth downstream.

Speech-onset invariant (critical):
- A source cue's start is WHEN THE SPEAKER STARTS TALKING. Viewers expect the subtitle to appear at that exact moment — not later.
- Every output cue MUST start at exactly the same time as one of the source cues it derives from. Do not invent new start times.
- When you split one source cue into multiple sub-cues: the FIRST sub-cue takes the source cue's start. Later sub-cues may start later, within the source cue's range.
- When you merge several source cues into one: take the EARLIEST source start.
- Never shift an output cue's start later than the onset of the speech it represents.

Translation approach:
- Render proper nouns using established ${lang} forms when they exist; otherwise follow ${lang}'s normal transliteration conventions.
- Match the tone, register, and character voice of the source.
- Prefer the phrasing a native ${lang} viewer would expect over a word-for-word rendering.
- For unfamiliar proper nouns or specialized terms, use whatever annotation convention native ${lang} subtitle tracks use (ruby / furigana, transliteration, italics, nothing at all). Apply it sparingly — only where a native viewer would want the help.

${lang} punctuation:
- Use ${lang}'s native punctuation conventions throughout. Do not leave ASCII punctuation where ${lang} has native forms (e.g. full-width for Japanese, \`¿¡\` for Spanish, guillemets for French, etc.).

Cue restructuring is expected, not optional:
Professional native-${lang} subtitle tracks regularly split one source cue into 2–3 shorter cues when the source cue would otherwise be too long, cross a clause boundary, or span a natural breath break. You should do the same. Split a source cue into multiple output cues when any of the following holds:
  - The ${lang} rendering would be awkwardly long for a single cue (follow ${lang}'s reading-speed norms).
  - The source cue spans a clause boundary — a comma, a line break (shown as \` / \`), or a connector ("and" / "but" / "then" / "because").
  - The speaker changes, or the topic shifts, within a single source cue.

When splitting:
  - The first sub-cue MUST start at the source cue's start (speech-onset invariant above).
  - Allocate time proportionally to where the split falls in the source (a mid-sentence comma near 50% → cue boundary near 50%). A line break is a strong split signal.
  - Each sub-cue is a single short breath unit.
  - For cross-cue continuation of a single sentence, use ${lang}'s native convention (whether that's an em-dash, ellipsis, specific punctuation, or nothing). Non-final sub-cues take no terminal punctuation; the final sub-cue takes its normal closing punctuation.

You may also merge tightly-spaced source cues into one when the combined rendering reads as a single short breath. Each output cue's start/end must fall within the overall time range of the source cues in this batch; cues must be in chronological order and must not overlap.

Use cue spacing as a tonal signal: short gap (< 1s) = rapid dialogue, crisp phrasing; long gap (> 5s) = monologue/narration, calmer phrasing.

Non-dialogue markers:
- If a cue is clearly non-dialogue narration (opening exposition, scene-setting voice-over) and ${lang} has a conventional marker for that, apply it to the FIRST cue of the narration passage only (not every cue).

Cues to SKIP entirely (emit ZERO <line> tags for these; do not emit any placeholder, empty tag, or text like "(no subtitle)"):
- Legal disclaimers shown at episode openings (e.g. "Fictional work. Any similarity to real names or events is coincidental.", "Underage smoking is prohibited.", studio logos).
- Visual-only on-screen text cards that are NOT spoken: all-caps location labels (e.g. "TOKYO STATION"), character-name / age title cards (e.g. "NAME / AGE 15"), time-skip captions ("A FEW DAYS LATER"), and similar chyrons. Native subtitle tracks omit these because viewers read them directly from the video.
- DO translate episode / chapter titles when they appear as subtitle cues (e.g. "EPISODE 1: AN OATH FOR PEACE").

I/O format:
- Input: a sequence of <line i="N" start="SEC" end="SEC">source</line>. The index N is only so you can refer back — do not echo it in the output.
- Output: a sequence of <line start="SEC" end="SEC">${lang}</line>. Use seconds with up to 3 decimal places.
- Output only <line> tags — no preamble, no code fences, no commentary.`;
}

type Progress = (done: number, total: number) => void;

export type TranslateOptions = {
  targetLanguage: string;
  signal?: AbortSignal;
  onProgress?: Progress;
};

class AbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
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

type ParsedLine = { start: number; end: number; text: string };

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
    const text = unescapeXml(m[2]).trim();
    if (!text) continue;
    out.push({ start, end, text });
  }
  if (out.length === 0) throw new Error("No <line> tags with start/end found in model response");
  return out;
}

function sanitizeOutput(
  parsed: ParsedLine[],
  sourceCues: Cue[],
  rangeStart: number,
  rangeEnd: number,
): TranslatedCue[] {
  const clamped: TranslatedCue[] = [];
  for (const p of parsed) {
    const start = Math.max(rangeStart, Math.min(rangeEnd, p.start));
    const end = Math.max(start + 0.001, Math.min(rangeEnd, p.end));
    clamped.push({ start, end, text: p.text });
  }
  clamped.sort((a, b) => a.start - b.start);

  // Speech-onset snap: for each source cue, pull the FIRST output cue whose
  // start falls in [src.start, src.end] back to src.start. Later output cues
  // that fall in the same source range (sub-cues of a split) keep their
  // starts, so multi-part splits survive.
  const sorted = [...sourceCues].sort((a, b) => a.start - b.start);
  let outIdx = 0;
  for (const src of sorted) {
    // Advance past outputs that end before this source starts (can't be matched).
    while (outIdx < clamped.length && clamped[outIdx].start < src.start) outIdx++;
    if (outIdx >= clamped.length) break;
    const out = clamped[outIdx];
    if (out.start <= src.end) {
      out.start = src.start;
      if (out.end <= out.start) out.end = out.start + 0.001;
      outIdx++; // only snap the first match; further outputs in this source range stay put
    }
  }

  clamped.sort((a, b) => a.start - b.start);
  // Collapse residual overlap so downstream binary-search returns a single cue per time.
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

async function callClaudeStreaming(
  apiKey: string,
  userContent: string,
  systemPrompt: string,
  onLineDone: () => void,
  signal?: AbortSignal,
): Promise<string> {
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    stream: true,
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userContent }],
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
  if (!res.ok || !res.body) {
    const err = await res.text().catch(() => "");
    const e = new Error(`Claude API ${res.status}: ${err}`);
    (e as Error & { status?: number }).status = res.status;
    throw e;
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let acc = "";
  let scanFrom = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let eventType = "";
        let dataStr = "";
        for (const l of raw.split("\n")) {
          if (l.startsWith("event:")) eventType = l.slice(6).trim();
          else if (l.startsWith("data:")) dataStr = l.slice(5).trim();
        }
        if (eventType === "content_block_delta" && dataStr) {
          try {
            const d = JSON.parse(dataStr) as { delta?: { text?: string } };
            const text = d.delta?.text ?? "";
            if (text) {
              acc += text;
              while (true) {
                const idx = acc.indexOf("</line>", scanFrom);
                if (idx === -1) break;
                scanFrom = idx + 7;
                onLineDone();
              }
            }
          } catch {}
        } else if (eventType === "error" && dataStr) {
          throw new Error(`Claude stream error: ${dataStr}`);
        }
        sep = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!acc) throw new Error("empty response from Claude");
  return acc;
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
  systemPrompt: string,
  onLineDone: () => void,
  signal?: AbortSignal,
): Promise<string> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new AbortError();
    try {
      return await callClaudeStreaming(apiKey, userContent, systemPrompt, onLineDone, signal);
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
  opts: TranslateOptions,
): Promise<TranslatedCue[]> {
  const { signal, onProgress, targetLanguage } = opts;
  const systemPrompt = buildSystemPrompt(targetLanguage);
  const indexed = cues.map((c, i) => ({ i, start: c.start, end: c.end, t: c.text }));
  const userContent = serializeInput(indexed);
  const total = cues.length;
  const rangeStart = indexed[0].start;
  const rangeEnd = indexed[indexed.length - 1].end;
  let done = 0;
  onProgress?.(0, total);

  const raw = await callClaudeWithRetry(
    apiKey,
    userContent,
    systemPrompt,
    () => {
      // Streaming onLineDone may exceed total briefly if the model emits
      // extra lines; clamp so the UI doesn't jump past 100%.
      done = Math.min(done + 1, total);
      onProgress?.(done, total);
    },
    signal,
  );
  const parsed = parseOutput(raw);
  const sanitized = sanitizeOutput(parsed, cues, rangeStart, rangeEnd);
  if (sanitized.length === 0) throw new Error("no valid cues in model response");
  onProgress?.(total, total);
  return sanitized;
}

export { AbortError };
