import type { CacheEntry } from "../types";

// Bump this when the cue-schema or translation behaviour changes so stale
// cached entries are ignored rather than mixed with the new format.
const CACHE_SCHEMA = 3;
const PREFIX = `sub/v${CACHE_SCHEMA}:`;

async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function keyFor(url: string, lang: string): Promise<string> {
  const h = await sha256(`${lang}\n${url}`);
  return PREFIX + h;
}

export async function getCache(url: string, lang: string): Promise<CacheEntry | null> {
  const key = await keyFor(url, lang);
  const res = await chrome.storage.local.get(key);
  return (res[key] as CacheEntry | undefined) ?? null;
}

export async function setCache(url: string, lang: string, entry: CacheEntry): Promise<void> {
  const key = await keyFor(url, lang);
  await chrome.storage.local.set({ [key]: entry });
}

export async function deleteCache(url: string, lang: string): Promise<void> {
  const key = await keyFor(url, lang);
  await chrome.storage.local.remove(key);
}

export async function getApiKey(): Promise<string | null> {
  const res = await chrome.storage.local.get("apiKey");
  return (res.apiKey as string | undefined) ?? null;
}

export async function setApiKey(apiKey: string): Promise<void> {
  await chrome.storage.local.set({ apiKey });
}

export const DEFAULT_TARGET_LANGUAGE = "Japanese";

export async function getTargetLanguage(): Promise<string> {
  const res = await chrome.storage.local.get("targetLanguage");
  const v = res.targetLanguage;
  return typeof v === "string" && v.trim() ? v : DEFAULT_TARGET_LANGUAGE;
}

export async function setTargetLanguage(lang: string): Promise<void> {
  await chrome.storage.local.set({ targetLanguage: lang });
}

export async function getShowTranslated(): Promise<boolean> {
  const res = await chrome.storage.local.get("showTranslated");
  return res.showTranslated !== false;
}

export async function setShowTranslated(v: boolean): Promise<void> {
  await chrome.storage.local.set({ showTranslated: v });
}

export async function getHideOriginal(): Promise<boolean> {
  const res = await chrome.storage.local.get("hideOriginal");
  return res.hideOriginal === true;
}

export async function setHideOriginal(v: boolean): Promise<void> {
  await chrome.storage.local.set({ hideOriginal: v });
}

export async function getEnabled(): Promise<boolean> {
  const res = await chrome.storage.local.get("enabled");
  // Default on: subtitle auto-translation is the extension's whole point.
  return res.enabled !== false;
}

export async function setEnabled(v: boolean): Promise<void> {
  await chrome.storage.local.set({ enabled: v });
}
