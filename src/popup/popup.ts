import {
  DEFAULT_TARGET_LANGUAGE,
  getApiKey,
  getHideOriginal,
  getShowTranslated,
  getTargetLanguage,
  setApiKey,
  setHideOriginal,
  setShowTranslated,
  setTargetLanguage,
} from "../lib/cache";
import { MODEL } from "../lib/translate";
import type {
  ExtensionMessage,
  PopupGetState,
  PopupRegenerate,
  PopupStart,
  StateSnapshot,
  Status,
} from "../types";

const LANGUAGES = [
  "Japanese",
  "Korean",
  "Chinese (Simplified)",
  "Chinese (Traditional)",
  "English",
  "Spanish",
  "French",
  "German",
  "Italian",
  "Portuguese (Brazilian)",
  "Portuguese (European)",
  "Russian",
  "Dutch",
  "Polish",
  "Turkish",
  "Arabic",
  "Hindi",
  "Thai",
  "Vietnamese",
  "Indonesian",
  "Swedish",
  "Norwegian",
  "Danish",
  "Finnish",
  "Greek",
  "Hebrew",
  "Czech",
  "Ukrainian",
];

const sub = document.getElementById("sub") as HTMLParagraphElement;
const dot = document.getElementById("dot") as HTMLSpanElement;
const statusText = document.getElementById("statusText") as HTMLSpanElement;
const bar = document.getElementById("bar") as HTMLDivElement;
const barFill = document.getElementById("barFill") as HTMLDivElement;
const action = document.getElementById("action") as HTMLButtonElement;
const regenerateBtn = document.getElementById("regenerate") as HTMLButtonElement;
const err = document.getElementById("err") as HTMLParagraphElement;
const modelLabel = document.getElementById("modelLabel") as HTMLSpanElement;
const showTranslatedCb = document.getElementById("showTranslated") as HTMLInputElement;
const hideOriginalCb = document.getElementById("hideOriginal") as HTMLInputElement;
const languageSelect = document.getElementById("targetLanguage") as HTMLSelectElement;
const apiKeyInput = document.getElementById("apiKey") as HTMLInputElement;
const saveApiKeyBtn = document.getElementById("saveApiKey") as HTMLButtonElement;
const apiKeyStatus = document.getElementById("apiKeyStatus") as HTMLParagraphElement;

sub.textContent = "Translates Prime Video subtitles with Claude.";

let currentLanguage = DEFAULT_TARGET_LANGUAGE;

function populateLanguageOptions(selected: string) {
  const names = LANGUAGES.includes(selected) ? LANGUAGES : [selected, ...LANGUAGES];
  languageSelect.innerHTML = "";
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === selected) opt.selected = true;
    languageSelect.appendChild(opt);
  }
}

function setModelLabel() {
  modelLabel.textContent = `${MODEL} · → ${currentLanguage} · ${__BUILD_VERSION__}`;
}

void getApiKey().then((key) => {
  if (key) apiKeyInput.value = key;
});
saveApiKeyBtn.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    apiKeyStatus.style.color = "#b91c1c";
    apiKeyStatus.textContent = "API key is empty.";
    return;
  }
  await setApiKey(key);
  apiKeyStatus.style.color = "#0a7a2f";
  apiKeyStatus.textContent = "Saved.";
  setTimeout(() => {
    apiKeyStatus.textContent = "";
  }, 2500);
});

void getShowTranslated().then((v) => {
  showTranslatedCb.checked = v;
});
void getHideOriginal().then((v) => {
  hideOriginalCb.checked = v;
});
void getTargetLanguage().then((l) => {
  currentLanguage = l;
  populateLanguageOptions(l);
  setModelLabel();
});
showTranslatedCb.addEventListener("change", () => {
  void setShowTranslated(showTranslatedCb.checked);
});
hideOriginalCb.addEventListener("change", () => {
  void setHideOriginal(hideOriginalCb.checked);
});
languageSelect.addEventListener("change", () => {
  currentLanguage = languageSelect.value;
  setModelLabel();
  void setTargetLanguage(currentLanguage);
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
    ready: `${currentLanguage} subtitles ready.`,
    error: "Something went wrong.",
  };
  statusText.textContent = label[s.status];

  if (s.status === "detected") {
    action.classList.remove("hidden");
    action.textContent = `Generate ${currentLanguage} subtitles`;
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
  setTimeout(() => {
    if (!contentReachable) renderUnreachable();
  }, 500);
}

void init();
