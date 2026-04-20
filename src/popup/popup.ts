import { MODEL, TARGET_LANGUAGE } from "../lib/translate";
import type {
  ExtensionMessage,
  PopupGetState,
  PopupRegenerate,
  PopupStart,
  StateSnapshot,
  Status,
} from "../types";

const sub = document.getElementById("sub") as HTMLParagraphElement;
const dot = document.getElementById("dot") as HTMLSpanElement;
const statusText = document.getElementById("statusText") as HTMLSpanElement;
const bar = document.getElementById("bar") as HTMLDivElement;
const barFill = document.getElementById("barFill") as HTMLDivElement;
const action = document.getElementById("action") as HTMLButtonElement;
const regenerateBtn = document.getElementById("regenerate") as HTMLButtonElement;
const err = document.getElementById("err") as HTMLParagraphElement;
const modelLabel = document.getElementById("modelLabel") as HTMLSpanElement;
const openOptions = document.getElementById("openOptions") as HTMLAnchorElement;

modelLabel.textContent = `${MODEL} · → ${TARGET_LANGUAGE}`;
sub.textContent = "Translates Prime Video subtitles with Claude.";

openOptions.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

let activeTabId: number | null = null;
let contentReachable = false;

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

function renderUnreachable() {
  dot.className = "dot idle";
  statusText.textContent = "Open a Prime Video page to use Jimaku.";
  bar.classList.add("hidden");
  action.classList.add("hidden");
  regenerateBtn.classList.add("hidden");
  err.style.display = "none";
}

function render(s: StateSnapshot) {
  dot.className = `dot ${s.status}`;
  bar.classList.add("hidden");
  action.classList.add("hidden");
  regenerateBtn.classList.add("hidden");
  regenerateBtn.disabled = false;
  action.disabled = false;
  err.style.display = "none";

  const label: Record<Status, string> = {
    idle: "Waiting for a subtitle track…",
    detected: "Subtitle track detected.",
    translating: "Translating…",
    ready: `${TARGET_LANGUAGE} subtitles ready.`,
    error: "Something went wrong.",
  };
  statusText.textContent = label[s.status];

  if (s.status === "detected") {
    action.classList.remove("hidden");
    action.textContent = `Generate ${TARGET_LANGUAGE} subtitles`;
  } else if (s.status === "translating") {
    const p = s.progress;
    const total = p?.total ?? 0;
    const done = p?.done ?? 0;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    bar.classList.remove("hidden");
    barFill.style.width = `${pct}%`;
    statusText.textContent = `Translating… ${done}/${total || "?"} (${pct}%)`;
  } else if (s.status === "ready") {
    regenerateBtn.classList.remove("hidden");
  } else if (s.status === "error") {
    action.classList.remove("hidden");
    action.textContent = "Retry";
    if (s.error) {
      err.style.display = "";
      err.textContent = s.error;
    }
  }
}

action.addEventListener("click", () => {
  if (activeTabId === null) return;
  action.disabled = true;
  const msg: PopupStart = { type: "POPUP_START" };
  chrome.tabs.sendMessage(activeTabId, msg).catch(() => {
    contentReachable = false;
    renderUnreachable();
  });
});

regenerateBtn.addEventListener("click", () => {
  if (activeTabId === null) return;
  regenerateBtn.disabled = true;
  const msg: PopupRegenerate = { type: "POPUP_REGENERATE" };
  chrome.tabs.sendMessage(activeTabId, msg).catch(() => {
    contentReachable = false;
    renderUnreachable();
  });
});

chrome.runtime.onMessage.addListener((raw: ExtensionMessage, sender) => {
  if (raw.type !== "STATE_UPDATE") return;
  if (sender.tab?.id !== activeTabId) return;
  contentReachable = true;
  render(raw.state);
});

async function init() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    renderUnreachable();
    return;
  }
  activeTabId = tab.id;
  const msg: PopupGetState = { type: "POPUP_GET_STATE" };
  try {
    await chrome.tabs.sendMessage(activeTabId, msg);
  } catch {
    renderUnreachable();
    return;
  }
  // If no STATE_UPDATE arrives shortly, fall back to unreachable message.
  setTimeout(() => {
    if (!contentReachable) renderUnreachable();
  }, 500);
}

void init();
