import {
  DEFAULT_TARGET_LANGUAGE,
  getApiKey,
  getEnabled,
  getHideOriginal,
  getShowTranslated,
  getTargetLanguage,
  setApiKey,
  setEnabled,
  setHideOriginal,
  setShowTranslated,
  setTargetLanguage,
} from "../lib/cache";
import { MODEL } from "../lib/translate";
import type { ExtensionMessage, PopupGetState, StateSnapshot } from "../types";

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
const titleText = document.getElementById("titleText") as HTMLParagraphElement;
const bar = document.getElementById("bar") as HTMLDivElement;
const barFill = document.getElementById("barFill") as HTMLDivElement;
const err = document.getElementById("err") as HTMLParagraphElement;
const modelLabel = document.getElementById("modelLabel") as HTMLSpanElement;
const enabledCb = document.getElementById("enabled") as HTMLInputElement;
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

void getEnabled().then((v) => {
  enabledCb.checked = v;
});
void getShowTranslated().then((v) => {
  showTranslatedCb.checked = v;
});
void getHideOriginal().then((v) => {
  hideOriginalCb.checked = v;
});
enabledCb.addEventListener("change", () => {
  void setEnabled(enabledCb.checked);
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

// --- Pure UI derivation ---

type PopupView = {
  dotClass: "idle" | "active" | "error";
  label: string;
  progressPct: number | null;
  errorMessage: string | null;
};

function deriveView(s: StateSnapshot): PopupView {
  if (!s.enabled) {
    return { dotClass: "idle", label: "Auto-translate is off.", progressPct: null, errorMessage: null };
  }
  const t = s.translation;
  if (t.phase === "error") {
    return {
      dotClass: "error",
      label: "Something went wrong.",
      progressPct: null,
      errorMessage: t.error,
    };
  }
  if (t.phase === "translating") {
    const p = t.progress;
    const done = p?.done ?? 0;
    const total = p?.total ?? 0;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    return {
      dotClass: "active",
      label: `Translating… ${done}/${total || "?"} (${pct}%)`,
      progressPct: pct,
      errorMessage: null,
    };
  }
  if (t.phase === "complete") {
    return {
      dotClass: "active",
      label: `${currentLanguage} subtitles ready.`,
      progressPct: null,
      errorMessage: null,
    };
  }
  // phase === "idle"
  if (s.hasSubtitle) {
    return {
      dotClass: "active",
      label: "Subtitle track detected.",
      progressPct: null,
      errorMessage: null,
    };
  }
  return {
    dotClass: "active",
    label: "Waiting for a subtitle track…",
    progressPct: null,
    errorMessage: null,
  };
}

function renderUnreachable() {
  dot.className = "dot idle";
  statusText.textContent = "Open a Prime Video page to use Jimaku.";
  bar.classList.add("hidden");
  err.style.display = "none";
}

function render(s: StateSnapshot) {
  const v = deriveView(s);
  dot.className = `dot ${v.dotClass}`;
  statusText.textContent = v.label;
  if (v.progressPct !== null) {
    bar.classList.remove("hidden");
    barFill.style.width = `${v.progressPct}%`;
  } else {
    bar.classList.add("hidden");
  }
  if (v.errorMessage) {
    err.style.display = "";
    err.textContent = v.errorMessage;
  } else {
    err.style.display = "none";
  }
  if (s.title) {
    titleText.textContent = s.title;
    titleText.style.display = "";
  } else {
    titleText.style.display = "none";
  }
}

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
