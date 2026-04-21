import { currentPlatform } from "../platforms";

const OVERLAY_HOST_ID = "jimaku-host";
const HIDE_ORIGINAL_STYLE_ID = "jimaku-hide-original";

function captionTextSelectors(): readonly string[] {
  return currentPlatform()?.captionTextSelectors ?? [];
}

function hideOriginalCss(): string {
  const selectors = currentPlatform()?.captionHideSelectors ?? [];
  if (selectors.length === 0) return "";
  return `
  ${selectors.join(",\n  ")} {
    visibility: hidden !important;
  }
`;
}

/** Find the native caption text span in the current platform's player DOM. */
export function nativeCaptionEl(): HTMLElement | null {
  for (const sel of captionTextSelectors()) {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (el) return el;
  }
  return null;
}

function ensureHost(): ShadowRoot {
  const existing = document.getElementById(OVERLAY_HOST_ID);
  if (existing?.shadowRoot) return existing.shadowRoot;

  const host = document.createElement("div");
  host.id = OVERLAY_HOST_ID;
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    pointerEvents: "none",
    zIndex: "2147483646",
  });
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    .line {
      position: fixed;
      left: 50%;
      top: 88%;
      transform: translate(-50%, -100%);
      max-width: 80%;
      padding: 6px 12px;
      font-family: "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif;
      font-size: min(3.5vw, 32px);
      line-height: 1.35;
      color: #fff;
      text-align: center;
      background: rgba(0, 0, 0, 0.55);
      border-radius: 6px;
      white-space: pre-wrap;
      pointer-events: none;
    }
    .line:empty { display: none; }
  `;
  root.appendChild(style);
  const line = document.createElement("div");
  line.className = "line";
  root.appendChild(line);
  return root;
}

function lineEl(): HTMLDivElement {
  return ensureHost().querySelector(".line") as HTMLDivElement;
}

/** Replace the overlay text. No-ops if the text is unchanged. */
export function setOverlayText(text: string): void {
  const line = lineEl();
  if (line.textContent !== text) line.textContent = text;
}

let lastCaptionRect: { top: number; height: number } | null = null;

function findCaptionTextRect(): { top: number; height: number } | null {
  const el = nativeCaptionEl();
  if (el) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      lastCaptionRect = { top: r.top, height: r.height };
      return lastCaptionRect;
    }
  }
  return lastCaptionRect;
}

function computeFontSizePx(video: HTMLVideoElement | null): number | null {
  // Derive from the video element's height. We used to mirror the native
  // caption's inline font-size, but players like Netflix vary it per cue
  // (and tear it down between cues), which made the overlay flicker.
  if (!video) return null;
  const h = video.getBoundingClientRect().height;
  if (h <= 0) return null;
  return Math.max(14, Math.min(36, h * 0.035));
}

export type PositionContext = {
  video: HTMLVideoElement | null;
  hideOriginal: boolean;
};

/** Position + size the overlay relative to the native caption or the video. */
export function updateOverlayPosition(ctx: PositionContext): void {
  const line = lineEl();
  const fontPx = computeFontSizePx(ctx.video);
  line.style.fontSize = fontPx !== null ? `${fontPx}px` : "";

  const rect = findCaptionTextRect();
  if (rect) {
    if (ctx.hideOriginal) {
      // Native captions are hidden via visibility: hidden so their layout box
      // still exists — place ours exactly where the text span sits.
      const centerY = rect.top + rect.height / 2;
      line.style.top = `${centerY}px`;
      line.style.transform = "translate(-50%, -50%)";
    } else {
      // Players usually put captions near the bottom, but occasionally at
      // the top (narration, on-screen labels). Stack above bottom-placed
      // captions and below top-placed ones so the translated line always
      // stays on-screen.
      const videoMidY = ctx.video
        ? ctx.video.getBoundingClientRect().top + ctx.video.getBoundingClientRect().height / 2
        : window.innerHeight / 2;
      const captionCenterY = rect.top + rect.height / 2;
      if (captionCenterY < videoMidY) {
        line.style.top = `${rect.top + rect.height + 4}px`;
        line.style.transform = "translate(-50%, 0)";
      } else {
        line.style.top = `${rect.top - 4}px`;
        line.style.transform = "translate(-50%, -100%)";
      }
    }
    return;
  }

  if (ctx.video) {
    const r = ctx.video.getBoundingClientRect();
    // Fallback: ~12% from the bottom of the video, matching typical placement.
    line.style.top = `${r.bottom - r.height * 0.12}px`;
    line.style.transform = "translate(-50%, -50%)";
    return;
  }
  line.style.top = "";
  line.style.transform = "";
}

/** Toggle the CSS injection that hides the platform's native captions. */
export function applyHideOriginal(on: boolean): void {
  const existing = document.getElementById(HIDE_ORIGINAL_STYLE_ID);
  if (on) {
    if (!existing) {
      const style = document.createElement("style");
      style.id = HIDE_ORIGINAL_STYLE_ID;
      style.textContent = hideOriginalCss();
      (document.head ?? document.documentElement).appendChild(style);
    }
  } else {
    existing?.remove();
  }
}
