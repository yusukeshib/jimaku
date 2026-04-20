#!/usr/bin/env node
// Offline eval harness that mirrors src/lib/translate.ts exactly.
// Reads /tmp/en.ttml2, calls the Claude API in 50-cue chunks with the same
// system prompt + rolling prev-context handoff, and writes results under eval/out/.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "out");

const MODEL = "claude-opus-4-7";
const TARGET_LANGUAGE = "Japanese";
const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const CHUNK_SIZE = 50;
const MAX_TOKENS = 8000;
const MAX_ATTEMPTS = 4;

const PROMPTS = {
  // Matches src/lib/translate.ts as of the baseline run (temperature removed).
  v1: `You are a film subtitle translator. Translate the source subtitles into natural, concise ${TARGET_LANGUAGE} subtitles.

About the input:
- Each <line> carries start/end seconds from the source subtitle track. The player uses whatever start/end you put on each output cue to decide when to show it, so your output timestamps are the ground truth downstream.

How to translate:
- Keep each line short enough to read quickly; insert a line break if it would otherwise be too long on screen.
- Render proper nouns in the target language's native script; follow established translations when they exist.
- Match the tone to the work's mood and each character's voice.
- Use the target language's native punctuation conventions.

Cue restructuring is encouraged:
- You decide the output cue structure. You may split one long source cue into several shorter cues, or merge tightly-spaced source cues into one — whatever reads most naturally. Professional native-language subtitle tracks routinely reflow the source cue boundaries for readability, and your output should too when it helps.
- Each output cue's start/end must fall within the overall time range of the source cues in this batch, cues must be in chronological order, and they should not overlap.
- Use cue spacing as tonal signal:
  - Short gap (< 1s) = rapid dialogue; crisp, clipped phrasing.
  - Long gap (> 5s) = monologue / narration; calmer phrasing.

I/O format:
- Input: a sequence of <line i="N" start="SEC" end="SEC">source</line>. The index N is only so you can refer back — do not echo it in the output.
- Output: a sequence of <line start="SEC" end="SEC">${TARGET_LANGUAGE}</line>. Use seconds with up to 3 decimal places.
- Output only <line> tags — no preamble, no code fences, no commentary.`,

  // v2: targeted additions from the baseline-vs-gold diff against Prime Video's
  // NIPPON SANGOKU track. Five rules, each addressing one measured gap:
  //   (a) split long cues at breath points (gold had 118 N>1 splits; v1 had 0)
  //   (b) em-dash `―` continuation on non-final cues (gold 104; v1 0)
  //   (c) skip on-screen text cards and legal disclaimers (gold dropped 17; v1 3)
  //   (d) `（ナレーション）` label for unambiguous non-dialogic narration
  //   (e) strict full-width Japanese punctuation, no ASCII quotes/commas
  v2: `You are a film subtitle translator. Translate the source subtitles into natural, concise ${TARGET_LANGUAGE} subtitles that read like a professionally authored native-language track — not a literal gloss of the source.

About the input:
- Each <line> carries start/end seconds from the source subtitle track. The player uses whatever start/end you put on each output cue to decide when to show it, so your output timestamps are the ground truth downstream.

Translation approach:
- Render proper nouns in ${TARGET_LANGUAGE}'s native script; follow established translations when they exist.
- Match the tone to the work's mood and each character's voice.
- Prefer the phrasing a native viewer would expect over a word-for-word rendering.

Cue restructuring is expected, not optional:
- Professional ${TARGET_LANGUAGE} subtitle tracks routinely split one source cue into 2–3 shorter cues, each a single breath unit. Do this whenever a single-cue rendering would exceed roughly 15 full-width characters or crosses a natural breath boundary (comma, topic shift, "and"/"but"/"then", clause break).
- When splitting, place each sub-cue's start proportionally within the source cue's time range — e.g. a comma in the middle of the source becomes a cue boundary near the midpoint; a clause break near 2/3 becomes a boundary near 2/3.
- You may also merge tightly-spaced source cues into one when the resulting line is short and reads as a single breath.
- Each output cue's start/end must fall within the overall time range of the source cues in this batch; cues must be in chronological order and must not overlap.
- Use cue spacing as tonal signal: short gap (< 1s) = rapid dialogue, crisp phrasing; long gap (> 5s) = monologue/narration, calmer phrasing.

Continuation across cues:
- When a cue continues a sentence into the next cue, end it with the half-width em-dash \`―\` (U+2015) and omit terminal punctuation. The final cue of the sentence carries its normal closing punctuation (none, \`。\`, \`？\`, or \`！\`).
- Example: \`圧倒的大敗を喫し―\` then \`諸外国に屈した。\`

Narration labeling:
- For clearly non-dialogic narration — opening exposition, scene-setting voice-over, historical recap — prefix the first cue of that narration passage with \`（ナレーション）\`. Do not prefix every cue of the passage; only the first.

Cues to SKIP (produce no output for these):
- Legal disclaimers shown at the episode opening (e.g. "Fictional work. Any similarity to real names or events is coincidental.", "Underage smoking is prohibited.").
- On-screen text cards that are visual-only and not spoken: all-caps location labels (e.g. "EHIME LIBRARY", "OSAKA"), character-name / age title cards (e.g. "NOBUHITO HIGASHIMACHI", "AOTERU MISUMI / AGE 15"), time-skip captions ("A FEW DAYS LATER"), and similar chyrons. Native ${TARGET_LANGUAGE} subtitle tracks omit these because viewers read them directly from the video.
- However, DO translate episode / chapter titles when they appear as subtitle cues (e.g. "EPISODE 1: AN OATH FOR PEACE").

${TARGET_LANGUAGE} punctuation conventions (strict):
- Use full-width punctuation only: \`。\` \`、\` \`！\` \`？\` \`「」\` \`『』\`. Do not use ASCII \`.\`, \`,\`, \`!\`, \`?\`, \`"\`, \`'\`.
- Prefer no trailing \`。\` on the final cue of a short utterance; use \`。\` mainly to mark a complete declarative sentence where it aids reading.
- Use a full-width space (\`　\` / U+3000) to separate list items or short pauses within a cue where a comma would feel heavy.

I/O format:
- Input: a sequence of <line i="N" start="SEC" end="SEC">source</line>. The index N is only so you can refer back — do not echo it in the output.
- Output: a sequence of <line start="SEC" end="SEC">${TARGET_LANGUAGE}</line>. Use seconds with up to 3 decimal places.
- Output only <line> tags — no preamble, no code fences, no commentary.`,

  // v3: builds on v2. Four diagnosed issues from the v2 diff:
  //   (a) Split rule only triggered 6 times of ~118 opportunities. Strengthen
  //       into a mechanical MUST with concrete triggers (source ≥ 3s AND has
  //       comma or `/`). Add two few-shot examples (non-NIPPON, to keep the
  //       eval clean) showing the split pattern in action.
  //   (b) Silent-skip failure: model emitted `(字幕なし)` placeholders. Rule
  //       now says emit zero <line> tags for skipped source cues.
  //   (c) Ruby hints regressed 9 → 4. Add an explicit rule for first-mention
  //       proper nouns with non-obvious readings.
  //   (d) `…` collapsed into `―`. Disambiguate: `―` for grammatical
  //       continuation across cues; `…` for trailing-off speech within a cue.
  v3: `You are a film subtitle translator. Translate the source subtitles into natural, concise ${TARGET_LANGUAGE} subtitles that read like a professionally authored native-language track — not a literal gloss of the source.

About the input:
- Each <line> carries start/end seconds from the source subtitle track. The player uses whatever start/end you put on each output cue to decide when to show it, so your output timestamps are the ground truth downstream.

Translation approach:
- Render proper nouns in ${TARGET_LANGUAGE}'s native script; follow established translations when they exist.
- Match the tone to the work's mood and each character's voice.
- Prefer the phrasing a native viewer would expect over a word-for-word rendering.
- First mention of a character name, place name, or proper-noun coinage with non-obvious kanji readings: append the hiragana reading with a full-width space, e.g. \`大和 やまと\`, \`三角青輝 みすみあおてる\`. On subsequent mentions of the same name, omit the reading. Do NOT add readings to common nouns or verbs (e.g. do not write \`勃発 ぼっぱつ\`, \`蔓延 まんえん\`, \`蜂起 ほうき\` — these are common enough that a reader doesn't need the gloss).

Cue splitting — this is mandatory, not stylistic:
A professional ${TARGET_LANGUAGE} subtitle track splits one source cue into 2–3 shorter cues far more often than it preserves them 1:1. You MUST split a source cue into two or more output cues when any of the following holds:
  - The source cue's duration is ≥ 3 seconds AND the source contains a comma or a \` / \` line break.
  - The source cue would render as more than ~15 full-width ${TARGET_LANGUAGE} characters.
  - The source cue contains a clause connector ("and", "but", "then", "because", "so that") that introduces a new thought.

When splitting:
  - Allocate time proportionally. A comma at ~40% through the source cue becomes a cue boundary near 40%. A line break is a strong split hint — treat it as ~50%.
  - Each sub-cue is a single short breath unit (≤ ~15 full-width chars).
  - Non-final sub-cues end with \`―\` (U+2015, half-width em-dash) and carry no terminal punctuation.
  - The final sub-cue of the sentence carries its normal closing punctuation (none, \`。\`, \`？\`, or \`！\`).

You may also merge tightly-spaced source cues into one when the combined rendering reads as a single short breath. Each output cue's start/end must fall within the overall time range of the source cues in this batch; cues must be in chronological order and must not overlap.

Use cue spacing as tonal signal: short gap (< 1s) = rapid dialogue, crisp phrasing; long gap (> 5s) = monologue/narration, calmer phrasing.

Continuation vs trailing-off:
- \`―\` (em-dash) at a cue's end: the sentence grammatically continues in the next cue. No final punctuation.
- \`…\` (ellipsis) within or at the end of a cue: the speaker trails off, hesitates, or leaves the thought unfinished. The ellipsis closes the cue; the next cue starts a new grammatical unit.
- Do not confuse these.

Narration labeling:
- For clearly non-dialogic narration — opening exposition, scene-setting voice-over, historical recap — prefix the first cue of that narration passage with \`（ナレーション）\`. Do not prefix every cue of the passage; only the first.

Cues to SKIP entirely (emit ZERO <line> tags for these; do not emit any placeholder, empty tag, or text like \`(字幕なし)\`):
- Legal disclaimers shown at the episode opening (e.g. "Fictional work. Any similarity to real names or events is coincidental.", "Underage smoking is prohibited.").
- On-screen text cards that are visual-only and not spoken: all-caps location labels (e.g. "EHIME LIBRARY", "OSAKA"), character-name / age title cards (e.g. "NOBUHITO HIGASHIMACHI", "AOTERU MISUMI / AGE 15"), time-skip captions ("A FEW DAYS LATER"), similar chyrons. Native ${TARGET_LANGUAGE} subtitle tracks omit these because viewers read them directly from the video.
- DO translate episode / chapter titles when they appear as subtitle cues (e.g. "EPISODE 1: AN OATH FOR PEACE").

${TARGET_LANGUAGE} punctuation conventions (strict):
- Use full-width punctuation only: \`。\` \`、\` \`！\` \`？\` \`「」\` \`『』\`. Do not use ASCII \`.\`, \`,\`, \`!\`, \`?\`, \`"\`, \`'\`.
- Prefer no trailing \`。\` on the final cue of a short utterance; use \`。\` mainly to mark a complete declarative sentence where it aids reading.
- Use a full-width space (\`　\` / U+3000) to separate list items or short pauses within a cue where a comma would feel heavy.

I/O format:
- Input: a sequence of <line i="N" start="SEC" end="SEC">source</line>. The index N is only so you can refer back — do not echo it in the output.
- Output: a sequence of <line start="SEC" end="SEC">${TARGET_LANGUAGE}</line>. Use seconds with up to 3 decimal places.
- Output only <line> tags — no preamble, no code fences, no commentary.

Worked examples (illustrative; pay attention to structure, not content):

Example A — split a long cue with a comma and continuation:
Input:
<line i="0" start="10.00" end="14.00">Suffering heavy taxes and constant famine, / the townspeople finally took up arms.</line>
Output:
<line start="10.00" end="12.00">重税と度重なる飢饉に苦しみ―</line>
<line start="12.00" end="14.00">町民はついに武器を取った</line>

Example B — narration opening, split at clause boundary:
Input:
<line i="0" start="0.00" end="5.00">Long ago, in a distant land, / a great war raged on for centuries.</line>
Output:
<line start="0.00" end="2.20">（ナレーション）遠い昔 遠き国で―</line>
<line start="2.20" end="5.00">大いなる戦が 何世紀も続いた</line>

Example C — skip an on-screen text card; translate the following dialogue normally:
Input:
<line i="0" start="100.00" end="102.00">TOKYO STATION</line>
<line i="1" start="102.50" end="105.00">We finally made it.</line>
Output:
<line start="102.50" end="105.00">やっと着いたな</line>`,

  // v4: generic prompt that works for any TARGET_LANGUAGE. Keeps the three
  // universally-applicable findings from earlier eval runs (skip text cards,
  // allow/expect splits, silent skip) but delegates ALL language-specific
  // conventions (continuation markers, narration labels, ruby/transliteration
  // style, punctuation form) to the model's knowledge of the target language.
  // The NIPPON SANGOKU gold informs but does not define the prompt.
  v4: `You are a film subtitle translator. Translate the source subtitles into natural ${TARGET_LANGUAGE} subtitles that read like a professionally authored native-${TARGET_LANGUAGE} track — not a literal gloss of the source.

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
- Output only <line> tags — no preamble, no code fences, no commentary.

Worked examples (these show structural patterns; apply analogous ${TARGET_LANGUAGE} conventions):

Example A — split a long source cue at a clause boundary, using ${TARGET_LANGUAGE}'s cross-cue continuation convention (if any):
Input:
<line i="0" start="10.00" end="14.00">Suffering heavy taxes and constant famine, / the townspeople finally took up arms.</line>
Output: two ${TARGET_LANGUAGE} cues, one per breath unit, with continuation marker if ${TARGET_LANGUAGE} uses one.

Example B — skip an on-screen text card; translate the following dialogue normally:
Input:
<line i="0" start="100.00" end="102.00">TOKYO STATION</line>
<line i="1" start="102.50" end="105.00">We finally made it.</line>
Output: one ${TARGET_LANGUAGE} cue for the utterance; NO cue for the text card.`,
};

// ---------- TTML parsing ----------

function parseClock(s) {
  if (!s) return NaN;
  const m = s.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  const v = Number(s);
  return Number.isFinite(v) ? v : NaN;
}

function parseTtmlCues(text) {
  const re = /<p\s+([^>]*)>([\s\S]*?)<\/p>/g;
  const attrRe = /(\w+(?::\w+)?)\s*=\s*"([^"]*)"/g;
  const cues = [];
  for (const m of text.matchAll(re)) {
    const attrs = {};
    for (const a of m[1].matchAll(attrRe)) attrs[a[1]] = a[2];
    const start = parseClock(attrs.begin);
    const end = parseClock(attrs.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const inner = m[2]
      .replace(/<br\s*\/?>/gi, " / ")
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
    if (!inner) continue;
    cues.push({ start, end, text: inner });
  }
  return cues;
}

// ---------- prompt plumbing (ported from src/lib/translate.ts) ----------

function escapeXml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function serializeInput(items) {
  return items
    .map(
      (x) =>
        `<line i="${x.i}" start="${x.start.toFixed(2)}" end="${x.end.toFixed(2)}">${escapeXml(x.t)}</line>`,
    )
    .join("\n");
}

function parseOutput(raw) {
  const re = /<line\s+([^>]*?)>([\s\S]*?)<\/line>/g;
  const attrRe = /(\w+)\s*=\s*"([^"]*)"/g;
  const out = [];
  for (const m of raw.matchAll(re)) {
    const attrs = {};
    for (const a of m[1].matchAll(attrRe)) attrs[a[1]] = a[2];
    const start = parseClock(attrs.start ?? "");
    const end = parseClock(attrs.end ?? "");
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const ja = unescapeXml(m[2]).trim();
    if (!ja) continue;
    out.push({ start, end, ja });
  }
  if (out.length === 0) throw new Error("No <line> tags with start/end found in model response");
  return out;
}

function sanitizeChunkOutput(parsed, chunkStart, chunkEnd) {
  const clamped = [];
  for (const p of parsed) {
    const start = Math.max(chunkStart, Math.min(chunkEnd, p.start));
    const end = Math.max(start + 0.001, Math.min(chunkEnd, p.end));
    clamped.push({ start, end, ja: p.ja });
  }
  clamped.sort((a, b) => a.start - b.start);
  for (let i = 1; i < clamped.length; i++) {
    if (clamped[i].start < clamped[i - 1].end) {
      clamped[i - 1].end = clamped[i].start;
    }
  }
  return clamped.filter((c) => c.end > c.start);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callClaudeOnce(apiKey, systemPrompt, userContent, prevContext) {
  const messages = [];
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
      { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
    ],
    messages,
  };

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": API_VERSION,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    const e = new Error(`Claude API ${res.status}: ${err}`);
    e.status = res.status;
    throw e;
  }
  const data = await res.json();
  const text = data.content?.find((c) => c.type === "text")?.text;
  if (!text) throw new Error("empty response from Claude");
  return { text, usage: data.usage };
}

async function callClaudeWithRetry(apiKey, systemPrompt, userContent, prevContext) {
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await callClaudeOnce(apiKey, systemPrompt, userContent, prevContext);
    } catch (e) {
      lastErr = e;
      const retryable = e.status === undefined || e.status === 429 || e.status >= 500;
      if (!retryable || attempt === MAX_ATTEMPTS - 1) throw e;
      const backoff = Math.min(30000, 1000 * 2 ** attempt) + Math.random() * 500;
      console.error(`  retry ${attempt + 1} in ${Math.round(backoff)}ms (${e.message.slice(0, 120)})`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

// ---------- main ----------

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set");
    process.exit(1);
  }
  const runTag = process.argv[2] ?? "baseline";
  // Map the run tag to a prompt variant. "baseline" historically means v1.
  // Tags ending in a letter suffix (v3a, v3b, ...) share the base key (v3); we
  // edit the prompt in-place and rerun with a new tag to keep outputs separate.
  const baseKey = runTag === "baseline" ? "v1" : runTag.split("-")[0].replace(/[a-z]$/, "");
  const promptKey = PROMPTS[runTag] ? runTag : baseKey;
  const systemPrompt = PROMPTS[promptKey];
  if (!systemPrompt) {
    console.error(`unknown prompt variant "${promptKey}" (known: ${Object.keys(PROMPTS).join(", ")})`);
    process.exit(1);
  }
  console.log(`Prompt variant: ${promptKey}`);
  const runDir = resolve(OUT_DIR, runTag);
  await mkdir(runDir, { recursive: true });
  await writeFile(resolve(runDir, "prompt.txt"), systemPrompt);

  const englishTtml = await readFile("/tmp/en.ttml2", "utf8");
  const cues = parseTtmlCues(englishTtml);
  console.log(`Parsed ${cues.length} English cues`);
  await writeFile(resolve(runDir, "input-cues.json"), JSON.stringify(cues, null, 2));

  const indexed = cues.map((c, i) => ({ i, start: c.start, end: c.end, t: c.text }));
  const chunks = chunk(indexed, CHUNK_SIZE);
  const result = [];
  const chunkLog = [];
  let prevContext = null;
  const t0 = Date.now();

  for (let ci = 0; ci < chunks.length; ci++) {
    const c = chunks[ci];
    const chunkStart = c[0].start;
    const chunkEnd = c[c.length - 1].end;
    const userContent = serializeInput(c);
    const chunkT0 = Date.now();

    try {
      const { text, usage } = await callClaudeWithRetry(apiKey, systemPrompt, userContent, prevContext);
      const parsed = parseOutput(text);
      const sanitized = sanitizeChunkOutput(parsed, chunkStart, chunkEnd);
      if (sanitized.length === 0) throw new Error("chunk produced no valid cues");
      result.push(...sanitized);
      prevContext = sanitized.slice(-5).map((p) => p.ja).join("\n");

      await writeFile(resolve(runDir, `chunk-${String(ci).padStart(2, "0")}-raw.txt`), text);
      chunkLog.push({
        chunk: ci,
        inputCues: c.length,
        outputCues: sanitized.length,
        timeRange: [chunkStart, chunkEnd],
        elapsedMs: Date.now() - chunkT0,
        usage,
      });
      console.log(
        `  chunk ${ci} (${c.length} → ${sanitized.length} cues, ${Date.now() - chunkT0}ms, in=${usage?.input_tokens} cache_read=${usage?.cache_read_input_tokens ?? 0} out=${usage?.output_tokens})`,
      );
    } catch (e) {
      console.error(`  chunk ${ci} failed: ${e.message}`);
      for (const src of c) result.push({ start: src.start, end: src.end, ja: src.t });
      chunkLog.push({ chunk: ci, error: e.message, inputCues: c.length });
    }
  }

  result.sort((a, b) => a.start - b.start);
  await writeFile(resolve(runDir, "cues.json"), JSON.stringify(result, null, 2));
  await writeFile(resolve(runDir, "chunk-log.json"), JSON.stringify(chunkLog, null, 2));

  const totalMs = Date.now() - t0;
  console.log(
    `Done. ${cues.length} in → ${result.length} out, ${chunks.length} chunks, ${(totalMs / 1000).toFixed(1)}s total. Written to ${runDir}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
