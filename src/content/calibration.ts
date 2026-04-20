import { normalizeCueText } from "./cueList";
import { nativeCaptionEl } from "./overlay";
import { state } from "./state";

// Minimum absolute delta to accept a new offset. Anything smaller is
// bookkeeping jitter from repeated observations of the same text.
const OFFSET_UPDATE_THRESHOLD_S = 0.05;

/**
 * Watch Prime Video's native caption text and keep `state.timeOffset`
 * calibrated to its timeline.
 *
 * Prime Video's `video.currentTime` differs from the TTML timeline because
 * of server-side ad insertion. We can't read the offset directly, but we
 * can measure it: when the native caption DOM displays a cue whose source
 * text matches one of our indexed cues, the offset is
 * `video.currentTime - matchedCue.start`.
 *
 * `onCalibrated` fires after `state.timeOffset` changes so the orchestrator
 * can repaint the overlay immediately.
 *
 * Returns a disposer.
 */
export function attachCalibration(video: HTMLVideoElement, onCalibrated: () => void): () => void {
  let lastSeenText = "";

  const tryCalibrate = () => {
    if (state.sourceIndex.size === 0) return;
    const el = nativeCaptionEl();
    const raw = el?.textContent ?? "";
    if (raw === lastSeenText) return;
    lastSeenText = raw;
    const key = normalizeCueText(raw);
    if (!key) return;
    const matches = state.sourceIndex.lookupByText(key);
    if (!matches || matches.length === 0) return;

    // Multiple source cues can share the same text ("Yes.", etc.). Pick the
    // one closest to the currently-assumed content time.
    const t = video.currentTime;
    const assumedContentTime = t - state.timeOffset;
    const best = matches.reduce((b, c) =>
      Math.abs(c.start - assumedContentTime) < Math.abs(b.start - assumedContentTime) ? c : b,
    );
    const newOffset = t - best.start;
    if (Math.abs(newOffset - state.timeOffset) < OFFSET_UPDATE_THRESHOLD_S) return;
    state.timeOffset = newOffset;
    onCalibrated();
  };

  // Scope narrowly when possible: observing the whole body subtree with
  // characterData would generate far more noise than we need.
  let textObserver: MutationObserver | null = null;
  let scoped: Element | null = null;
  const scopeTo = (el: Element) => {
    if (scoped === el) return;
    textObserver?.disconnect();
    scoped = el;
    textObserver = new MutationObserver(tryCalibrate);
    textObserver.observe(el, { childList: true, subtree: true, characterData: true });
    tryCalibrate();
  };

  const existing = nativeCaptionEl();
  if (existing) scopeTo(existing);

  // The caption element can be (re)mounted by the player; watch for it.
  const discoverObserver = new MutationObserver(() => {
    const el = nativeCaptionEl();
    if (el && el !== scoped) scopeTo(el);
  });
  discoverObserver.observe(document.body ?? document.documentElement, {
    childList: true,
    subtree: true,
  });

  return () => {
    textObserver?.disconnect();
    discoverObserver.disconnect();
  };
}
