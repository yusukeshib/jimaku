import { describe, expect, it } from "vitest";
import type { Cue } from "../types";
import { __test__ } from "./translate";

const { parseTimeValue, parseOutput, parseLineXml, sanitizeOutput, escapeXml, unescapeXml } =
  __test__;

describe("parseTimeValue", () => {
  it("parses plain seconds", () => {
    expect(parseTimeValue("12.5")).toBe(12.5);
    expect(parseTimeValue("0")).toBe(0);
    expect(parseTimeValue("600.125")).toBe(600.125);
  });

  it("parses HH:MM:SS clock-time", () => {
    expect(parseTimeValue("00:01:00")).toBe(60);
    expect(parseTimeValue("01:23:45.678")).toBe(3600 + 23 * 60 + 45.678);
  });

  it("returns NaN for garbage", () => {
    expect(parseTimeValue("abc")).toBeNaN();
    expect(parseTimeValue("")).toBeNaN();
  });
});

describe("escapeXml / unescapeXml", () => {
  it("round-trips the XML-dangerous characters", () => {
    const s = `<tag attr="v">he said "hi" & 'bye' <3</tag>`;
    expect(unescapeXml(escapeXml(s))).toBe(s);
  });

  it("does not touch newlines or regular characters", () => {
    const s = "line1\nline2 with 日本語";
    expect(escapeXml(s)).toBe(s);
  });
});

describe("parseLineXml", () => {
  it("parses a well-formed single line", () => {
    const r = parseLineXml(`<line start="10.00" end="12.50">こんにちは</line>`);
    expect(r).toEqual({ start: 10, end: 12.5, text: "こんにちは" });
  });

  it("accepts attributes in any order", () => {
    const r = parseLineXml(`<line end="12.50" start="10.00">hi</line>`);
    expect(r).toEqual({ start: 10, end: 12.5, text: "hi" });
  });

  it("unescapes XML entities inside the text", () => {
    const r = parseLineXml(`<line start="1" end="2">a &amp; b &lt;3</line>`);
    expect(r?.text).toBe("a & b <3");
  });

  it("rejects lines with missing attributes", () => {
    expect(parseLineXml(`<line start="1">text</line>`)).toBeNull();
    expect(parseLineXml(`<line>text</line>`)).toBeNull();
  });

  it("rejects lines with empty text", () => {
    expect(parseLineXml(`<line start="1" end="2"></line>`)).toBeNull();
    expect(parseLineXml(`<line start="1" end="2">   </line>`)).toBeNull();
  });
});

describe("parseOutput", () => {
  it("extracts multiple lines from a mixed stream", () => {
    const raw = `
<line start="1.00" end="2.00">A</line>
<line start="3.00" end="4.50">B</line>
<line start="5.00" end="6.00">C</line>
    `;
    const out = parseOutput(raw);
    expect(out).toEqual([
      { start: 1, end: 2, text: "A" },
      { start: 3, end: 4.5, text: "B" },
      { start: 5, end: 6, text: "C" },
    ]);
  });

  it("skips lines with unparseable timestamps", () => {
    const raw = `
<line start="1.00" end="2.00">ok</line>
<line start="bad" end="x">nope</line>
<line start="3.00" end="4.00">ok2</line>
    `;
    const out = parseOutput(raw);
    expect(out.map((l) => l.text)).toEqual(["ok", "ok2"]);
  });

  it("throws when no lines found", () => {
    expect(() => parseOutput("")).toThrow(/No <line>/);
    expect(() => parseOutput("hello world")).toThrow(/No <line>/);
  });
});

describe("sanitizeOutput", () => {
  const src = (arr: Array<[number, number, string]>): Cue[] =>
    arr.map(([start, end, text]) => ({ start, end, text }));

  it("clamps cues to the range and keeps end > start", () => {
    const parsed = [
      { start: -5, end: 1, text: "before" },
      { start: 2, end: 3, text: "inside" },
      { start: 99, end: 100, text: "after" },
    ];
    const out = sanitizeOutput(parsed, src([[0, 10, "all"]]), 0, 10);
    // Each cue's start is clamped into [0, 10]; end may be up to 0.001 past
    // the range to preserve the non-empty invariant.
    expect(out.every((c) => c.start >= 0 && c.start <= 10)).toBe(true);
    expect(out.every((c) => c.end > c.start)).toBe(true);
  });

  it("snaps an output cue's start back to its source cue start", () => {
    const sources = src([[10, 12, "hello"]]);
    const parsed = [{ start: 10.4, end: 12, text: "ハロー" }];
    const out = sanitizeOutput(parsed, sources, 10, 12);
    expect(out[0].start).toBe(10);
  });

  it("preserves later sub-cues of a split (only first gets snapped)", () => {
    const sources = src([[10, 20, "long source"]]);
    const parsed = [
      { start: 10.5, end: 14, text: "part one" },
      { start: 15, end: 19, text: "part two" },
    ];
    const out = sanitizeOutput(parsed, sources, 10, 20);
    expect(out[0].start).toBe(10); // snapped
    expect(out[1].start).toBe(15); // not snapped
  });

  it("snaps merged cues to the earliest source start", () => {
    const sources = src([
      [10, 12, "a"],
      [13, 16, "b"],
    ]);
    const parsed = [{ start: 11, end: 15, text: "merged" }];
    const out = sanitizeOutput(parsed, sources, 10, 16);
    expect(out[0].start).toBe(10);
  });

  it("collapses residual overlap so every time has exactly one cue", () => {
    const sources = src([
      [0, 2, "a"],
      [2, 4, "b"],
    ]);
    const parsed = [
      { start: 0, end: 3, text: "A" }, // overruns into next
      { start: 2, end: 4, text: "B" },
    ];
    const out = sanitizeOutput(parsed, sources, 0, 4);
    expect(out[0].end).toBeLessThanOrEqual(out[1].start);
  });

  it("sorts unordered input", () => {
    const sources = src([
      [0, 5, "a"],
      [10, 15, "b"],
    ]);
    const parsed = [
      { start: 10, end: 15, text: "B" },
      { start: 0, end: 5, text: "A" },
    ];
    const out = sanitizeOutput(parsed, sources, 0, 15);
    expect(out.map((c) => c.text)).toEqual(["A", "B"]);
  });
});
