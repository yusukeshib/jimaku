#!/usr/bin/env node
// Compare a translation run under eval/out/<tag>/cues.json against gold /tmp/ja.ttml2
// and emit a structural/style diff report to eval/out/<tag>/report.md.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'").replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
    if (!inner) continue;
    cues.push({ start, end, text: inner });
  }
  return cues;
}

function overlap(a, b) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

function pairByOverlap(ours, gold) {
  // For each of our cues, find the gold cues it overlaps (and vice versa).
  const oursToGold = ours.map((o) => ({
    ours: o,
    gold: gold
      .map((g, gi) => ({ g, gi, ov: overlap(o, g) }))
      .filter((x) => x.ov > 0)
      .sort((a, b) => b.ov - a.ov),
  }));
  const goldToOurs = gold.map((g) => ({
    gold: g,
    ours: ours
      .map((o, oi) => ({ o, oi, ov: overlap(o, g) }))
      .filter((x) => x.ov > 0)
      .sort((a, b) => b.ov - a.ov),
  }));
  return { oursToGold, goldToOurs };
}

// ---------- style markers ----------

const RUBY_RE = /[\u4e00-\u9faf々〇]+\s+[\u3040-\u309f]+/g; // "kanji + space + hiragana"
const PAREN_LABEL_RE = /（[^）]{1,20}）/g; // （ナレーション）, （三角青輝）
const DASH_CONT_RE = /―/g; // mid-sentence continuation dash
const ELLIPSIS_RE = /…/g;

function styleMarkers(text) {
  return {
    rubyHints: (text.match(RUBY_RE) || []).length,
    parenLabels: (text.match(PAREN_LABEL_RE) || []).length,
    continuationDashes: (text.match(DASH_CONT_RE) || []).length,
    ellipses: (text.match(ELLIPSIS_RE) || []).length,
    commasWestern: (text.match(/,/g) || []).length,
    periodsWestern: (text.match(/\./g) || []).length,
    japaneseCommas: (text.match(/、/g) || []).length,
    japanesePeriods: (text.match(/。/g) || []).length,
    latinChars: (text.match(/[A-Za-z]/g) || []).length,
    length: text.length,
  };
}

function sumMarkers(cues) {
  const sum = {
    rubyHints: 0, parenLabels: 0, continuationDashes: 0, ellipses: 0,
    commasWestern: 0, periodsWestern: 0, japaneseCommas: 0, japanesePeriods: 0,
    latinChars: 0, length: 0,
  };
  for (const c of cues) {
    const m = styleMarkers(c.text ?? c.ja ?? "");
    for (const k of Object.keys(sum)) sum[k] += m[k];
  }
  return sum;
}

// ---------- main ----------

async function main() {
  const tag = process.argv[2] ?? "baseline";
  const runDir = resolve(__dirname, "out", tag);
  const oursRaw = JSON.parse(await readFile(resolve(runDir, "cues.json"), "utf8"));
  const ours = oursRaw.map((c) => ({ start: c.start, end: c.end, text: c.ja }));
  const gold = parseTtmlCues(await readFile("/tmp/ja.ttml2", "utf8"));
  const english = parseTtmlCues(await readFile("/tmp/en.ttml2", "utf8"));

  const { oursToGold, goldToOurs } = pairByOverlap(ours, gold);

  // Coverage
  const oursTimespan = ours.length ? [ours[0].start, ours[ours.length - 1].end] : [0, 0];
  const goldTimespan = gold.length ? [gold[0].start, gold[gold.length - 1].end] : [0, 0];
  const engTimespan = english.length ? [english[0].start, english[english.length - 1].end] : [0, 0];

  // What gold dropped relative to English (cues in English time range where no gold overlap)
  const engCuesWithoutGold = english.filter(
    (e) => !gold.some((g) => overlap(e, g) > 0),
  );
  const engCuesWithoutOurs = english.filter(
    (e) => !ours.some((o) => overlap(e, o) > 0),
  );

  // 1:N structure
  const splitBuckets = { "0 (dropped)": 0, "1": 0, "2": 0, "3": 0, "4+": 0 };
  for (const e of english) {
    const g = gold.filter((g) => overlap(e, g) > 0).length;
    const k = g === 0 ? "0 (dropped)" : g === 1 ? "1" : g === 2 ? "2" : g === 3 ? "3" : "4+";
    splitBuckets[k]++;
  }
  const oursSplitBuckets = { "0 (dropped)": 0, "1": 0, "2": 0, "3": 0, "4+": 0 };
  for (const e of english) {
    const o = ours.filter((o) => overlap(e, o) > 0).length;
    const k = o === 0 ? "0 (dropped)" : o === 1 ? "1" : o === 2 ? "2" : o === 3 ? "3" : "4+";
    oursSplitBuckets[k]++;
  }

  // Style markers
  const oursStyle = sumMarkers(ours);
  const goldStyle = sumMarkers(gold);

  // Avg cue duration / length
  const avgDur = (cs) => cs.reduce((s, c) => s + (c.end - c.start), 0) / Math.max(1, cs.length);
  const avgLen = (cs) => cs.reduce((s, c) => s + (c.text ?? c.ja ?? "").length, 0) / Math.max(1, cs.length);

  // ---------- paired side-by-side for the first ~25 english cues ----------
  const pairs = english.slice(0, 30).map((e, ei) => {
    const g = gold.filter((g) => overlap(e, g) > 0).map((g) => `[${g.start.toFixed(1)}] ${g.text}`);
    const o = ours.filter((o) => overlap(e, o) > 0).map((o) => `[${o.start.toFixed(1)}] ${o.text}`);
    return { ei, range: `${e.start.toFixed(1)}–${e.end.toFixed(1)}`, eng: e.text, ours: o.join(" ‖ "), gold: g.join(" ‖ ") };
  });

  // ---------- specific divergence samples ----------
  // Cues where our count diverges from gold's count for the same English cue
  const divergent = [];
  for (const e of english) {
    const gCount = gold.filter((g) => overlap(e, g) > 0).length;
    const oCount = ours.filter((o) => overlap(e, o) > 0).length;
    if (gCount !== oCount) divergent.push({ e, gCount, oCount });
  }

  // ---------- report ----------
  const lines = [];
  lines.push(`# Translation eval: \`${tag}\` vs Prime Video official JA`);
  lines.push("");
  lines.push(`- Input: ${english.length} English cues, ${engTimespan[0].toFixed(1)}–${engTimespan[1].toFixed(1)}s`);
  lines.push(`- Ours:  ${ours.length} cues, ${oursTimespan[0].toFixed(1)}–${oursTimespan[1].toFixed(1)}s, avg dur ${avgDur(ours).toFixed(2)}s, avg len ${avgLen(ours).toFixed(1)} chars`);
  lines.push(`- Gold:  ${gold.length} cues, ${goldTimespan[0].toFixed(1)}–${goldTimespan[1].toFixed(1)}s, avg dur ${avgDur(gold).toFixed(2)}s, avg len ${avgLen(gold).toFixed(1)} chars`);
  lines.push("");
  lines.push(`## Coverage`);
  lines.push(`- English cues with **no gold** overlap: ${engCuesWithoutGold.length}`);
  for (const c of engCuesWithoutGold.slice(0, 10)) {
    lines.push(`  - [${c.start.toFixed(1)}–${c.end.toFixed(1)}] ${c.text}`);
  }
  if (engCuesWithoutGold.length > 10) lines.push(`  - ... (+${engCuesWithoutGold.length - 10} more)`);
  lines.push(`- English cues with **no ours** overlap: ${engCuesWithoutOurs.length}`);
  for (const c of engCuesWithoutOurs.slice(0, 10)) {
    lines.push(`  - [${c.start.toFixed(1)}–${c.end.toFixed(1)}] ${c.text}`);
  }
  lines.push("");
  lines.push(`## Split structure (english cue → N translated cues)`);
  lines.push(`| bucket | gold | ours |`);
  lines.push(`|---|---|---|`);
  for (const k of Object.keys(splitBuckets)) {
    lines.push(`| ${k} | ${splitBuckets[k]} | ${oursSplitBuckets[k]} |`);
  }
  lines.push("");
  lines.push(`## Style markers (total occurrences across all cues)`);
  lines.push(`| marker | ours | gold |`);
  lines.push(`|---|---|---|`);
  for (const k of Object.keys(oursStyle)) {
    lines.push(`| ${k} | ${oursStyle[k]} | ${goldStyle[k]} |`);
  }
  lines.push("");
  lines.push(`## Divergent cue-count pairs`);
  lines.push(`- ${divergent.length} of ${english.length} English cues got a different number of translated cues from us vs gold.`);
  lines.push("");
  lines.push(`## First 30 cues side-by-side`);
  lines.push(`| i | range (s) | English | Ours | Gold |`);
  lines.push(`|---|---|---|---|---|`);
  for (const p of pairs) {
    lines.push(`| ${p.ei} | ${p.range} | ${p.eng.replace(/\|/g, "\\|")} | ${p.ours.replace(/\|/g, "\\|")} | ${p.gold.replace(/\|/g, "\\|")} |`);
  }

  const reportPath = resolve(runDir, "report.md");
  await writeFile(reportPath, lines.join("\n"));
  console.log(`Report written to ${reportPath}`);

  // Also write a JSON snapshot for programmatic follow-ups.
  await writeFile(
    resolve(runDir, "report.json"),
    JSON.stringify(
      {
        tag,
        counts: { english: english.length, ours: ours.length, gold: gold.length },
        avg: {
          ours: { dur: avgDur(ours), len: avgLen(ours) },
          gold: { dur: avgDur(gold), len: avgLen(gold) },
        },
        splitBuckets: { gold: splitBuckets, ours: oursSplitBuckets },
        styleMarkers: { ours: oursStyle, gold: goldStyle },
        coverage: {
          engWithoutGold: engCuesWithoutGold.length,
          engWithoutOurs: engCuesWithoutOurs.length,
        },
        divergentCount: divergent.length,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
