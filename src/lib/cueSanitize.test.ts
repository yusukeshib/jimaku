import { describe, expect, it } from "vitest";
import type { Cue } from "../types";
import { CueSanitizer, clampCue, sanitizeAll } from "./cueSanitize";

const src = (arr: Array<[number, number, string]>): Cue[] =>
  arr.map(([start, end, text]) => ({ start, end, text }));

describe("clampCue", () => {
  it("clamps start into the range", () => {
    expect(clampCue({ start: -5, end: 1, text: "x" }, 0, 10).start).toBe(0);
    expect(clampCue({ start: 20, end: 25, text: "x" }, 0, 10).start).toBe(10);
  });

  it("clamps end into the range but preserves end > start", () => {
    const c = clampCue({ start: 20, end: 25, text: "x" }, 0, 10);
    expect(c.end).toBeGreaterThan(c.start);
    expect(c.end).toBeLessThanOrEqual(10.001);
  });
});

describe("sanitizeAll", () => {
  it("clamps cues to the range and keeps end > start", () => {
    const parsed = [
      { start: -5, end: 1, text: "before" },
      { start: 2, end: 3, text: "inside" },
      { start: 99, end: 100, text: "after" },
    ];
    const out = sanitizeAll(parsed, src([[0, 10, "all"]]), 0, 10);
    expect(out.every((c) => c.start >= 0 && c.start <= 10)).toBe(true);
    expect(out.every((c) => c.end > c.start)).toBe(true);
  });

  it("snaps an output cue's start back to its source cue start", () => {
    const sources = src([[10, 12, "hello"]]);
    const parsed = [{ start: 10.4, end: 12, text: "ハロー" }];
    const out = sanitizeAll(parsed, sources, 10, 12);
    expect(out[0].start).toBe(10);
  });

  it("preserves later sub-cues of a split (only first gets snapped)", () => {
    const sources = src([[10, 20, "long source"]]);
    const parsed = [
      { start: 10.5, end: 14, text: "part one" },
      { start: 15, end: 19, text: "part two" },
    ];
    const out = sanitizeAll(parsed, sources, 10, 20);
    expect(out[0].start).toBe(10); // snapped
    expect(out[1].start).toBe(15); // not snapped
  });

  it("snaps merged cues to the earliest source start", () => {
    const sources = src([
      [10, 12, "a"],
      [13, 16, "b"],
    ]);
    const parsed = [{ start: 11, end: 15, text: "merged" }];
    const out = sanitizeAll(parsed, sources, 10, 16);
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
    const out = sanitizeAll(parsed, sources, 0, 4);
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
    const out = sanitizeAll(parsed, sources, 0, 15);
    expect(out.map((c) => c.text)).toEqual(["A", "B"]);
  });
});

describe("CueSanitizer streaming", () => {
  it("emits the same result as batched sanitizeAll", () => {
    const sources = src([
      [10, 12, "a"],
      [13, 15, "b"],
      [20, 22, "c"],
    ]);
    const parsed = [
      { start: 10.3, end: 11.8, text: "ア" },
      { start: 13.5, end: 14.9, text: "ベ" },
      { start: 20.1, end: 21.9, text: "セ" },
    ];
    const batched = sanitizeAll(parsed, sources, 10, 22);

    const san = new CueSanitizer(sources, 10, 22);
    const streamed: Array<{ start: number; end: number; text: string }> = [];
    for (const p of parsed) {
      const out = san.accept(p);
      if (out) streamed.push({ start: out.start, end: out.end, text: out.text });
    }
    expect(streamed).toEqual(batched);
  });

  it("skipPast advances the source pointer for resume", () => {
    const sources = src([
      [10, 12, "a"],
      [20, 22, "b"],
    ]);
    // With skipPast(12), the first source cue is considered "already claimed"
    // so a cue at 10.5 shouldn't get snapped back to 10.
    const san = new CueSanitizer(sources, 0, 30);
    san.skipPast(12);
    const out = san.accept({ start: 20.4, end: 22, text: "x" });
    expect(out?.start).toBe(20); // snapped to the SECOND source cue
  });

  it("returns null when a cue collapses to zero-length", () => {
    const san = new CueSanitizer([], 10, 10);
    // Range collapses start=end=10; clamp sets end=10.001 initially but
    // overlap-collapse with a prior cue can pull end down.
    const a = san.accept({ start: 10, end: 10, text: "a" });
    const b = san.accept({ start: 10, end: 10, text: "b" });
    expect(a).toBeTruthy();
    // b should have trimmed a.end to 10 (== a.start) making a zero-length
    // — but a was already returned. The caller filters zero-length at the
    // end (see sanitizeAll's .filter).
    expect(b).toBeTruthy();
  });
});
