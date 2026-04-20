// The main episode has a long duration; the background-looping trailer on
// the detail page is short (~1–2 min). Translating before the user hits
// Play wastes API calls on the wrong video, so we gate on real playback
// of a long-duration <video>.
const MAIN_VIDEO_MIN_DURATION = 300;

/**
 * Prime Video keeps a paused preroll-ad <video> alongside the playing main
 * <video>. Prefer whichever is actually playing, falling back to the longest.
 */
export function findVideo(): HTMLVideoElement | null {
  const videos = Array.from(document.querySelectorAll("video")).filter(
    (v) => v.videoWidth > 0 && v.videoHeight > 0,
  );
  if (videos.length === 0) return null;
  const playing = videos.filter((v) => !v.paused);
  const pool = playing.length > 0 ? playing : videos;
  return pool.reduce((best, v) => (v.duration > (best?.duration ?? 0) ? v : best), pool[0]);
}

export function isMainVideoPlaying(): boolean {
  return Array.from(document.querySelectorAll("video")).some(
    (v) => !v.paused && v.videoWidth > 0 && v.duration > MAIN_VIDEO_MIN_DURATION,
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

export type PlaybackHandler = (playing: boolean) => void;

/**
 * Poll the video element state every 500ms and emit on transitions between
 * "main video playing" and "not". More reliable than `play`/`pause` events,
 * which can fire before `duration` is known when Prime Video swaps the
 * trailer element out for the episode element.
 *
 * Returns a disposer.
 */
export function watchForPlayback(onChange: PlaybackHandler): () => void {
  let wasPlaying = false;
  const interval = window.setInterval(() => {
    const playing = isMainVideoPlaying();
    if (playing === wasPlaying) return;
    wasPlaying = playing;
    onChange(playing);
  }, 500);
  return () => window.clearInterval(interval);
}
