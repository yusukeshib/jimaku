import { DEFAULT_TARGET_LANGUAGE } from "../lib/cache";
import type { Cue, Status, TranslatedCue } from "../types";

type Listener = () => void;

// Single store for the content script. Status writes go through `transition`
// so state-machine changes happen in one place and can be audited.
class ContentState {
  // --- Settings (mirrored from chrome.storage) ---
  showTranslated = true;
  hideOriginal = false;
  targetLanguage = DEFAULT_TARGET_LANGUAGE;
  enabled = true;

  // --- Translation state ---
  subtitleUrl: string | null = null;
  status: Status = "idle";
  progress: { done: number; total: number } | null = null;
  error: string | null = null;
  timeOffset = 0;
  cues: TranslatedCue[] | null = null;
  sortedStarts: number[] | null = null;
  sourceCues: Cue[] | null = null;
  sourceByNormText: Map<string, Cue[]> | null = null;

  // --- Runtime resources owned by other modules but referenced here ---
  video: HTMLVideoElement | null = null;
  abortCtrl: AbortController | null = null;
  // Cleanup hooks registered by modules (video sync, calibration observer).
  // Populated by those modules' attach/detach entry points.
  cleanupVideo: (() => void) | null = null;
  cleanupCalibration: (() => void) | null = null;

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }

  /** Single entry point for status changes so we can audit/trace transitions. */
  transition(next: Status, _reason?: string) {
    if (this.status === next) return;
    this.status = next;
    this.notify();
  }

  /** Broadcast a change without moving status (e.g. progress update). */
  touch() {
    this.notify();
  }

  /** Reset everything tied to a specific subtitle URL; keep settings. */
  clearPerUrl() {
    this.abortCtrl?.abort();
    this.abortCtrl = null;
    this.cleanupVideo?.();
    this.cleanupCalibration?.();
    this.cues = null;
    this.sortedStarts = null;
    this.sourceCues = null;
    this.sourceByNormText = null;
    this.timeOffset = 0;
    this.progress = null;
    this.error = null;
  }
}

export const state = new ContentState();
