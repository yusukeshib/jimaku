import type { Cue, TranslatedCue } from "../types";

export const MODEL = "claude-opus-4-7";
const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const CHUNK_SIZE = 50;

const SYSTEM_PROMPT = `あなたは映画字幕の翻訳者です。英語字幕を自然で簡潔な日本語字幕に訳してください。

ルール:
- 1行あたり全角20字程度を目安に、長ければ改行を入れる
- 固有名詞はカタカナ表記（既に定着した訳がある場合はそれに従う）
- 口調は作品の雰囲気やキャラクターに合わせる
- 疑問符・感嘆符は全角、中黒は半角スペースに置き換えない
- 入力JSONの i (index) は絶対に改変しない

入出力:
- 入力は JSON 配列 [{"i": number, "t": string}]
- 出力も JSON 配列 [{"i": number, "ja": string}] のみ。前置き・コードフェンス・解説は一切付けない。`;

type Progress = (done: number, total: number) => void;

type AnthropicContentBlock = { type: string; text?: string };
type AnthropicResponse = { content?: AnthropicContentBlock[] };

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function extractJson(raw: string): string {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("model did not return JSON array");
  }
  return raw.slice(start, end + 1);
}

async function callClaude(
  apiKey: string,
  userContent: string,
  prevContext: string | null,
): Promise<string> {
  const messages: Array<{ role: string; content: string }> = [];
  if (prevContext) {
    messages.push({
      role: "user",
      content: `参考: 直前のチャンクの翻訳結果です。文脈と口調の一貫性に使ってください（このチャンクは翻訳しないでください）。\n${prevContext}`,
    });
    messages.push({ role: "assistant", content: "了解しました。次のチャンクの翻訳を待ちます。" });
  }
  messages.push({ role: "user", content: userContent });

  const body = {
    model: MODEL,
    max_tokens: 8000,
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
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API ${res.status}: ${err}`);
  }
  const data = (await res.json()) as AnthropicResponse;
  const text = data.content?.find((c) => c.type === "text")?.text;
  if (!text) throw new Error("empty response from Claude");
  return text;
}

export async function translateCues(
  cues: Cue[],
  apiKey: string,
  onProgress?: Progress,
): Promise<TranslatedCue[]> {
  const indexed = cues.map((c, i) => ({ i, t: c.text }));
  const chunks = chunk(indexed, CHUNK_SIZE);
  const result: TranslatedCue[] = new Array(cues.length);
  let done = 0;
  let prevContext: string | null = null;

  for (const c of chunks) {
    const userContent = JSON.stringify(c);
    const raw = await callClaude(apiKey, userContent, prevContext);
    const json = extractJson(raw);
    const parsed = JSON.parse(json) as Array<{ i: number; ja: string }>;

    for (const item of parsed) {
      const original = cues[item.i];
      if (!original) continue;
      result[item.i] = { start: original.start, end: original.end, ja: item.ja };
    }

    prevContext = parsed
      .slice(-5)
      .map((p) => `${p.i}: ${p.ja}`)
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
