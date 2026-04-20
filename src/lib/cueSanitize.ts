/**
 * Cue sanitization: clamp to range, snap to source-cue starts (speech-onset
 * invariant), and collapse overlap. Designed to be usable both in streaming
 * (one cue at a time) and batched (whole array at once) paths.
 */

import type { Cue, TranslatedCue } from "../types";

/** Clamp a cue to [rangeStart, rangeEnd] while keeping end > start. */
export function clampCue(
  cue: { start: number; end: number; text: string },
  rangeStart: number,
  rangeEnd: number,
): TranslatedCue {
  const start = Math.max(rangeStart, Math.min(rangeEnd, cue.start));
  const end = Math.max(start + 0.001, Math.min(rangeEnd, cue.end));
  return { start, end, text: cue.text };
}

/**
 * Streaming-capable sanitizer. Call `accept` with cues in chronological
 * order; each call clamps to the range, snaps to the next unclaimed source
 * cue if in range, and collapses overlap with the previously emitted cue.
 *
 * Speech-onset snap semantics (same as the original batched logic):
 *   - For each source cue in order, pull the FIRST unclaimed output cue
 *     whose start falls within [src.start, src.end] back to src.start.
 *   - Later output cues in the same source range are sub-cues of a split
 *     and keep their own starts.
 *   - The pointer advances as we claim source cues, so earlier sources
 *     can't retroactively match later outputs.
 *
 * Overlap collapse: when accepting cue B after cue A, if B.start < A.end
 * then A.end is trimmed to B.start. The caller sees A mutated in place.
 */
export class CueSanitizer {
  private srcIdx = 0;
  private readonly sortedSources: Cue[];
  private readonly rangeStart: number;
  private readonly rangeEnd: number;
  private previous: TranslatedCue | null = null;

  constructor(sourceCues: Cue[], rangeStart: number, rangeEnd: number) {
    this.sortedSources = [...sourceCues].sort((a, b) => a.start - b.start);
    this.rangeStart = rangeStart;
    this.rangeEnd = rangeEnd;
  }

  /**
   * Advance the source pointer past cues whose start is ≤ `priorLastStart`.
   * Used on resume so already-translated source cues aren't re-matched.
   */
  skipPast(priorLastStart: number): void {
    while (
      this.srcIdx < this.sortedSources.length &&
      this.sortedSources[this.srcIdx].start <= priorLastStart
    ) {
      this.srcIdx++;
    }
  }

  /**
   * Sanitize a single cue. Returns the finalized cue (same object reference
   * stored internally for subsequent overlap collapse), or null if the cue
   * collapsed to zero-length.
   */
  accept(raw: { start: number; end: number; text: string }): TranslatedCue | null {
    const clamped = clampCue(raw, this.rangeStart, this.rangeEnd);
    let { start, end } = clamped;

    // Snap start to the next unclaimed source cue that contains it.
    while (this.srcIdx < this.sortedSources.length && this.sortedSources[this.srcIdx].end < start) {
      this.srcIdx++;
    }
    if (this.srcIdx < this.sortedSources.length) {
      const src = this.sortedSources[this.srcIdx];
      if (start >= src.start && start <= src.end) {
        start = src.start;
        if (end <= start) end = start + 0.001;
        this.srcIdx++;
      }
    }

    // Overlap collapse with previous emitted cue.
    if (this.previous && start < this.previous.end) {
      this.previous.end = start;
    }

    if (end <= start) return null;
    const out: TranslatedCue = { start, end, text: clamped.text };
    this.previous = out;
    return out;
  }
}

/**
 * Sanitize an entire batch of parsed cues against a source track.
 *
 * Equivalent to running a fresh CueSanitizer over the batch after sorting.
 */
export function sanitizeAll(
  parsed: Array<{ start: number; end: number; text: string }>,
  sourceCues: Cue[],
  rangeStart: number,
  rangeEnd: number,
): TranslatedCue[] {
  const sorted = [...parsed].sort((a, b) => a.start - b.start);
  const san = new CueSanitizer(sourceCues, rangeStart, rangeEnd);
  const out: TranslatedCue[] = [];
  for (const c of sorted) {
    const accepted = san.accept(c);
    if (accepted) out.push(accepted);
  }
  // Drop any cue whose trimmed end collapsed below start.
  return out.filter((c) => c.end > c.start);
}
