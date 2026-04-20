#!/usr/bin/env node
// Three-way comparison: baseline (v1) vs a later run vs gold. Emits a summary
// markdown showing which metrics moved in which direction.
//
// Usage: node eval/compare.mjs <laterTag>  (default "v2")

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadReport(tag) {
  const j = JSON.parse(await readFile(resolve(__dirname, "out", tag, "report.json"), "utf8"));
  return j;
}

async function loadCues(tag) {
  const c = JSON.parse(await readFile(resolve(__dirname, "out", tag, "cues.json"), "utf8"));
  return c.map((x) => ({ start: x.start, end: x.end, text: x.ja }));
}

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

function arrow(newV, oldV, goldV) {
  // Show whether the metric moved toward gold.
  const distOld = Math.abs(oldV - goldV);
  const distNew = Math.abs(newV - goldV);
  if (distNew < distOld) return "↑";
  if (distNew > distOld) return "↓";
  return "=";
}

async function main() {
  const later = process.argv[2] ?? "v2";
  const base = "baseline";
  const [rBase, rLater] = await Promise.all([loadReport(base), loadReport(later)]);
  const [cBase, cLater] = await Promise.all([loadCues(base), loadCues(later)]);
  const english = parseTtmlCues(await readFile("/tmp/en.ttml2", "utf8"));
  const gold = parseTtmlCues(await readFile("/tmp/ja.ttml2", "utf8"));

  const out = [];
  out.push(`# Three-way comparison: \`${base}\` → \`${later}\` vs gold`);
  out.push("");
  out.push(`Direction arrow: ↑ = moved toward gold, ↓ = moved away, = no change.`);
  out.push("");
  out.push(`## Counts`);
  out.push(`| metric | ${base} | ${later} | gold | dir |`);
  out.push(`|---|---|---|---|---|`);
  const c = (k) => [rBase.counts[k], rLater.counts[k], gold.length];
  out.push(`| total cues | ${rBase.counts.ours} | ${rLater.counts.ours} | ${gold.length} | ${arrow(rLater.counts.ours, rBase.counts.ours, gold.length)} |`);
  out.push(`| avg cue duration (s) | ${rBase.avg.ours.dur.toFixed(2)} | ${rLater.avg.ours.dur.toFixed(2)} | ${rLater.avg.gold.dur.toFixed(2)} | ${arrow(rLater.avg.ours.dur, rBase.avg.ours.dur, rLater.avg.gold.dur)} |`);
  out.push(`| avg cue length (chars) | ${rBase.avg.ours.len.toFixed(1)} | ${rLater.avg.ours.len.toFixed(1)} | ${rLater.avg.gold.len.toFixed(1)} | ${arrow(rLater.avg.ours.len, rBase.avg.ours.len, rLater.avg.gold.len)} |`);
  out.push("");
  out.push(`## Split buckets (english cue → N translated cues)`);
  out.push(`| bucket | ${base} | ${later} | gold | dir |`);
  out.push(`|---|---|---|---|---|`);
  for (const k of ["1", "2", "3", "4+", "0 (dropped)"]) {
    out.push(`| ${k} | ${rBase.splitBuckets.ours[k]} | ${rLater.splitBuckets.ours[k]} | ${rBase.splitBuckets.gold[k]} | ${arrow(rLater.splitBuckets.ours[k], rBase.splitBuckets.ours[k], rBase.splitBuckets.gold[k])} |`);
  }
  out.push("");
  out.push(`## Style markers`);
  out.push(`| marker | ${base} | ${later} | gold | dir |`);
  out.push(`|---|---|---|---|---|`);
  for (const k of Object.keys(rBase.styleMarkers.ours)) {
    out.push(`| ${k} | ${rBase.styleMarkers.ours[k]} | ${rLater.styleMarkers.ours[k]} | ${rBase.styleMarkers.gold[k]} | ${arrow(rLater.styleMarkers.ours[k], rBase.styleMarkers.ours[k], rBase.styleMarkers.gold[k])} |`);
  }
  out.push("");
  out.push(`## Coverage`);
  out.push(`| metric | ${base} | ${later} | gold | dir |`);
  out.push(`|---|---|---|---|---|`);
  out.push(`| english cues with no translation | ${rBase.coverage.engWithoutOurs} | ${rLater.coverage.engWithoutOurs} | ${rBase.coverage.engWithoutGold} | ${arrow(rLater.coverage.engWithoutOurs, rBase.coverage.engWithoutOurs, rBase.coverage.engWithoutGold)} |`);
  out.push(`| divergent cue-count pairs | ${rBase.divergentCount} | ${rLater.divergentCount} | 0 | ${arrow(rLater.divergentCount, rBase.divergentCount, 0)} |`);
  out.push("");
  out.push(`## First 20 cues side-by-side (english → baseline ‖ later ‖ gold)`);
  out.push(`| i | range | english | ${base} | ${later} | gold |`);
  out.push(`|---|---|---|---|---|---|`);
  for (let i = 0; i < Math.min(20, english.length); i++) {
    const e = english[i];
    const pick = (cs) => cs.filter((c) => overlap(e, c) > 0).map((c) => c.text).join(" ‖ ");
    out.push(`| ${i} | ${e.start.toFixed(1)}–${e.end.toFixed(1)} | ${e.text.replace(/\|/g, "\\|")} | ${pick(cBase).replace(/\|/g, "\\|")} | ${pick(cLater).replace(/\|/g, "\\|")} | ${pick(gold).replace(/\|/g, "\\|")} |`);
  }

  const path = resolve(__dirname, "out", later, "compare.md");
  await writeFile(path, out.join("\n"));
  console.log(`Comparison written to ${path}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
