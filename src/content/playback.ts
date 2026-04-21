// The main episode has a long duration; the background-looping trailer on
// the detail page is short (~1–2 min). Translating before the user hits
// Play wastes API calls on the wrong video, so we gate on real playback
// of a long-duration <video>.
const MAIN_VIDEO_MIN_DURATION = 300;

// Prime Video pre-mounts the long episode <video> on the detail page but
// leaves it with a 0×0 bounding box until the player opens. Require a real
// layout box so "playback page" means "player is actually up."
function isMainVideoQualified(v: HTMLVideoElement): boolean {
  if (v.videoWidth === 0 || v.duration <= MAIN_VIDEO_MIN_DURATION) return false;
  const r = v.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/**
 * Return the main episode <video>, or null. Excludes the detail-page trailer
 * (short duration) and the pre-mounted-but-invisible episode element on the
 * detail page (no layout box) — only a qualified, visible main <video> wins.
 */
export function findVideo(): HTMLVideoElement | null {
  const videos = Array.from(document.querySelectorAll("video")).filter(isMainVideoQualified);
  if (videos.length === 0) return null;
  const playing = videos.filter((v) => !v.paused);
  const pool = playing.length > 0 ? playing : videos;
  return pool.reduce((best, v) => (v.duration > (best?.duration ?? 0) ? v : best), pool[0]);
}

export function isMainVideoPlaying(): boolean {
  return Array.from(document.querySelectorAll("video")).some(
    (v) => !v.paused && isMainVideoQualified(v),
  );
}

export type VideoFoundHandler = (video: HTMLVideoElement) => void;

/**
 * Fire `onFound` whenever a qualifying video becomes available in the DOM.
 * Throttled via a 500ms timer + a subtree MutationObserver.
 *
 * Returns a disposer.
 */
export function watchForVideo(onFound: VideoFoundHandler): () => void {
  let throttle: number | null = null;
  const tick = () => {
    throttle = null;
    const video = findVideo();
    if (video) onFound(video);
  };
  const schedule = () => {
    if (throttle !== null) return;
    throttle = window.setTimeout(tick, 500);
  };
  const observer = new MutationObserver(schedule);
  const target = document.body ?? document.documentElement;
  observer.observe(target, { childList: true, subtree: true });
  // Kick once in case a video already exists when we start watching.
  schedule();
  return () => {
    observer.disconnect();
    if (throttle !== null) {
      window.clearTimeout(throttle);
      throttle = null;
    }
  };
}

export type PlaybackState = "playing" | "paused" | "absent";
export type PlaybackHandler = (state: PlaybackState) => void;

function currentPlaybackState(): PlaybackState {
  const videos = Array.from(document.querySelectorAll("video")).filter(isMainVideoQualified);
  if (videos.length === 0) return "absent";
  return videos.some((v) => !v.paused) ? "playing" : "paused";
}

/**
 * Poll the video element every 500ms and emit on transitions between
 * playing / paused / absent. Distinguishing paused from absent lets callers
 * keep an in-flight translation running across in-player pauses while still
 * aborting when the user leaves the playback page.
 *
 * Returns a disposer.
 */
export function watchForPlayback(onChange: PlaybackHandler): () => void {
  let prev: PlaybackState | null = null;
  const interval = window.setInterval(() => {
    const next = currentPlaybackState();
    if (next === prev) return;
    prev = next;
    onChange(next);
  }, 500);
  return () => window.clearInterval(interval);
}
