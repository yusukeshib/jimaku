import { t } from "../lib/i18n";
import { currentPlatform } from "../platforms";
import { state } from "./state";

const HOST_ID = "jimaku-hint-host";
const GRACE_MS = 3000;

let dismissed = false;
let playingSince: number | null = null;
let recheckTimer: number | null = null;

function ensureHintRoot(): ShadowRoot {
  const existing = document.getElementById(HOST_ID);
  if (existing?.shadowRoot) return existing.shadowRoot;

  const host = document.createElement("div");
  host.id = HOST_ID;
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    pointerEvents: "none",
    zIndex: "2147483647",
  });
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    .hint {
      position: fixed;
      top: 16px;
      right: 16px;
      max-width: min(360px, 80vw);
      padding: 14px 16px;
      background: #ffffff;
      color: #111827;
      border-radius: 10px;
      border-left: 4px solid #2563eb;
      box-shadow: 0 10px 32px rgba(0, 0, 0, 0.45), 0 2px 6px rgba(0, 0, 0, 0.25);
      font-family: "Hiragino Kaku Gothic ProN", "Noto Sans JP", -apple-system, system-ui, sans-serif;
      font-size: 13px;
      line-height: 1.4;
      pointer-events: auto;
      display: none;
      gap: 10px;
      align-items: flex-start;
    }
    .hint.show { display: flex; }
    .hint .content { flex: 1; }
    .hint .title { font-weight: 700; margin-bottom: 3px; color: #111827; }
    .hint .body { color: #4b5563; }
    .hint .close {
      background: transparent;
      border: none;
      color: #6b7280;
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
      padding: 2px 6px;
      margin: -2px -6px -2px 0;
      border-radius: 4px;
    }
    .hint .close:hover { color: #111827; background: rgba(0, 0, 0, 0.06); }
  `;
  root.appendChild(style);
  const el = document.createElement("div");
  el.className = "hint";
  el.innerHTML = `
    <div class="content">
      <div class="title"></div>
      <div class="body"></div>
    </div>
    <button class="close" type="button" aria-label="">×</button>
  `;
  root.appendChild(el);
  const closeBtn = el.querySelector(".close") as HTMLButtonElement;
  closeBtn.addEventListener("click", () => {
    dismissed = true;
    hide();
  });
  return root;
}

function hintEl(): HTMLDivElement {
  return ensureHintRoot().querySelector(".hint") as HTMLDivElement;
}

function show() {
  const el = hintEl();
  (el.querySelector(".title") as HTMLElement).textContent = t("hint_enable_subtitles_title");
  (el.querySelector(".body") as HTMLElement).textContent = t("hint_enable_subtitles_body");
  const closeBtn = el.querySelector(".close") as HTMLButtonElement;
  closeBtn.setAttribute("aria-label", t("hint_dismiss"));
  el.classList.add("show");
}

function hide() {
  const existing = document.getElementById(HOST_ID);
  const el = existing?.shadowRoot?.querySelector(".hint") as HTMLElement | null;
  el?.classList.remove("show");
}

/** Called by state subscription; decides show/hide on every state change. */
export function updateSubtitleHint() {
  if (state.playback === "playing") {
    if (playingSince === null) playingSince = Date.now();
  } else {
    playingSince = null;
  }

  const platform = currentPlatform();
  const shouldShow =
    platform !== null &&
    state.enabled &&
    state.providerReady &&
    state.playback === "playing" &&
    !state.subtitleUrl &&
    !dismissed;

  if (recheckTimer !== null) {
    window.clearTimeout(recheckTimer);
    recheckTimer = null;
  }

  if (!shouldShow) {
    hide();
    return;
  }

  const elapsed = playingSince !== null ? Date.now() - playingSince : 0;
  if (elapsed >= GRACE_MS) {
    show();
    return;
  }
  // Within grace period — re-check once it expires.
  recheckTimer = window.setTimeout(() => {
    recheckTimer = null;
    updateSubtitleHint();
  }, GRACE_MS - elapsed);
}

/** Reset session-local dismissal when navigating to a new title. */
export function resetSubtitleHint() {
  dismissed = false;
  playingSince = null;
  if (recheckTimer !== null) {
    window.clearTimeout(recheckTimer);
    recheckTimer = null;
  }
  hide();
}
