import { DEFAULT_TARGET_LANGUAGE } from "../lib/cache";
import type { PlaybackState, TranslatedCue, TranslationPhase } from "../types";
import { CueList, SourceCueIndex } from "./cueList";

type Listener = () => void;

/**
 * Single source of truth for the content script. Event handlers call the
 * `on*` methods below; state emits `notify()` on every change so subscribers
 * (overlay, broadcast to background/popup) stay in sync without event
 * handlers touching UI directly.
 *
 * Rule of thumb: event → state method → notify → subscribers derive UI.
 * Never mutate fields from outside; never call `notify()` manually.
 */
class ContentState {
  // --- Settings (mirrored from chrome.storage) ---
  showTranslated = true;
  hideOriginal = false;
  targetLanguage = DEFAULT_TARGET_LANGUAGE;
  enabled = true;

  // --- Translation state ---
  subtitleUrl: string | null = null;
  phase: TranslationPhase = "idle";
  progress: { done: number; total: number } | null = null;
  error: string | null = null;
  timeOffset = 0;
  readonly cues = new CueList();
  readonly sourceIndex = new SourceCueIndex();

  // --- Playback state ---
  playback: PlaybackState = "absent";

  // --- Runtime resources (not broadcast) ---
  // Lifecycle invariant: `video` is non-null exactly when playback is
  // "playing" or "paused". Mutated only via onVideoAttached/onVideoDetached
  // from the single sync function in content.ts.
  video: HTMLVideoElement | null = null;
  abortCtrl: AbortController | null = null;
  cleanupCalibration: (() => void) | null = null;

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }

  // --- Settings events ---

  setShowTranslated(v: boolean) {
    if (this.showTranslated === v) return;
    this.showTranslated = v;
    this.notify();
  }

  setHideOriginal(v: boolean) {
    if (this.hideOriginal === v) return;
    this.hideOriginal = v;
    this.notify();
  }

  setTargetLanguage(v: string) {
    if (this.targetLanguage === v) return;
    this.targetLanguage = v;
    this.notify();
  }

  setEnabled(v: boolean) {
    if (this.enabled === v) return;
    this.enabled = v;
    this.notify();
  }

  // --- Translation lifecycle events ---

  onSubtitleDetected(url: string) {
    if (this.subtitleUrl === url) return;
    this.subtitleUrl = url;
    this.notify();
  }

  onCachedCuesHydrated(cues: TranslatedCue[], complete: boolean) {
    this.cues.set(cues);
    this.phase = complete ? "complete" : "idle";
    this.progress = complete ? null : { done: cues.length, total: 0 };
    this.error = null;
    this.notify();
  }

  onTranslationStarted(total: number, resumeFrom: TranslatedCue[] | null) {
    if (resumeFrom && resumeFrom.length > 0) this.cues.set(resumeFrom);
    else this.cues.clear();
    this.phase = "translating";
    this.progress = { done: resumeFrom?.length ?? 0, total };
    this.error = null;
    this.notify();
  }

  onTranslationCueAppended(cue: TranslatedCue) {
    this.cues.append(cue);
    this.notify();
  }

  onTranslationProgress(done: number, total: number) {
    this.progress = { done, total };
    this.notify();
  }

  onTranslationComplete(cues: TranslatedCue[]) {
    this.cues.set(cues);
    this.phase = "complete";
    this.progress = null;
    this.error = null;
    this.notify();
  }

  onTranslationFailed(message: string) {
    this.phase = "error";
    this.error = message;
    this.progress = null;
    this.notify();
  }

  onTranslationAborted() {
    // Paused or left playback mid-stream. Keep cues + subtitleUrl, revert
    // phase to idle — a future play/resume will pick up from partial cache.
    if (this.phase !== "translating") return;
    this.phase = "idle";
    this.notify();
  }

  // --- Playback events ---

  onPlaybackChanged(next: PlaybackState) {
    if (this.playback === next) return;
    this.playback = next;
    this.notify();
  }

  onVideoAttached(video: HTMLVideoElement, cleanupCalibration: () => void) {
    if (this.video === video) return;
    this.cleanupCalibration?.();
    this.video = video;
    this.cleanupCalibration = cleanupCalibration;
    this.notify();
  }

  onVideoDetached() {
    if (!this.video) return;
    this.cleanupCalibration?.();
    this.cleanupCalibration = null;
    this.video = null;
    this.notify();
  }

  // --- Lifecycle / reset ---

  /** TAB_RESET from background: drop subtitle + cues, revert phase to idle.
   *  Leaves video binding alone — that's owned by the playback sync loop. */
  onTabReset() {
    this.abortCtrl?.abort();
    this.abortCtrl = null;
    this.cues.clear();
    this.sourceIndex.clear();
    this.subtitleUrl = null;
    this.phase = "idle";
    this.progress = null;
    this.error = null;
    this.timeOffset = 0;
    this.notify();
  }

  /** New subtitle URL under same tab — drop per-URL state but keep settings. */
  onSubtitleUrlSwitching() {
    this.abortCtrl?.abort();
    this.abortCtrl = null;
    this.cues.clear();
    this.sourceIndex.clear();
    this.timeOffset = 0;
    this.progress = null;
    this.error = null;
    this.phase = "idle";
    this.notify();
  }

  onTimeOffsetChanged(offset: number) {
    if (this.timeOffset === offset) return;
    this.timeOffset = offset;
    this.notify();
  }
}

export const state = new ContentState();
