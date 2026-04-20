import type { Cue, TranslatedCue } from "../types";

/** Normalize caption text for identity matching (lowercase, strip punctuation). */
export function normalizeCueText(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} ]+/gu, "")
    .trim();
}

/**
 * Sorted list of translated cues with fast point lookup.
 *
 * Maintains cues ordered by `start` and a parallel array of starts for
 * binary search. All mutations go through the methods below so the
 * parallel-arrays invariant is guaranteed by construction.
 */
export class CueList {
  private cues: TranslatedCue[] = [];
  private starts: number[] = [];

  clear(): void {
    this.cues = [];
    this.starts = [];
  }

  /** Replace the list with a new set of cues (sorts defensively). */
  set(next: TranslatedCue[]): void {
    const sorted = [...next].sort((a, b) => a.start - b.start);
    this.cues = sorted;
    this.starts = sorted.map((c) => c.start);
  }

  /**
   * Insert a streamed cue into the sorted list.
   *
   * Streaming emits in chronological order so the common path is O(1)
   * tail-append; keeps a binary-search fallback for stray out-of-order emits.
   */
  append(cue: TranslatedCue): void {
    const last = this.cues[this.cues.length - 1];
    if (!last || last.start <= cue.start) {
      this.cues.push(cue);
      this.starts.push(cue.start);
      return;
    }
    let lo = 0;
    let hi = this.cues.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.starts[mid] <= cue.start) lo = mid + 1;
      else hi = mid;
    }
    this.cues.splice(lo, 0, cue);
    this.starts.splice(lo, 0, cue.start);
  }

  /**
   * Return the cue active at `seconds`, or null if none.
   *
   * Last cue whose start ≤ seconds, if that cue's end ≥ seconds.
   */
  findAt(seconds: number): TranslatedCue | null {
    if (this.cues.length === 0) return null;
    let lo = 0;
    let hi = this.starts.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (this.starts[mid] <= seconds) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (idx === -1) return null;
    const cue = this.cues[idx];
    return seconds <= cue.end ? cue : null;
  }

  get size(): number {
    return this.cues.length;
  }

  /** Snapshot of the cue list (mutation-safe for cache writes). */
  snapshot(): TranslatedCue[] {
    return this.cues.slice();
  }
}

/**
 * Source (English) cues indexed by normalized text for O(1) caption-match
 * lookup. Used by calibration to find the source cue matching the native
 * caption DOM, and by the track resolver to pick the active track.
 */
export class SourceCueIndex {
  private _cues: Cue[] = [];
  private byNormText: Map<string, Cue[]> = new Map();

  clear(): void {
    this._cues = [];
    this.byNormText.clear();
  }

  set(cues: Cue[]): void {
    this._cues = cues;
    this.byNormText.clear();
    for (const c of cues) {
      const key = normalizeCueText(c.text);
      if (!key) continue;
      const arr = this.byNormText.get(key);
      if (arr) arr.push(c);
      else this.byNormText.set(key, [c]);
    }
  }

  /** All cues matching the normalized text, or undefined if none. */
  lookupByText(normalizedText: string): Cue[] | undefined {
    return this.byNormText.get(normalizedText);
  }

  get cues(): Cue[] {
    return this._cues;
  }

  get size(): number {
    return this._cues.length;
  }
}
