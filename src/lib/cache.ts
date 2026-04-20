import type { CacheEntry } from "../types";

// Bump this when the cue-schema or translation behaviour changes so stale
// cached entries are ignored rather than mixed with the new format.
const CACHE_SCHEMA = 2;
const PREFIX = `sub/v${CACHE_SCHEMA}:`;

async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function keyForUrl(url: string): Promise<string> {
  const h = await sha256(url);
  return PREFIX + h;
}

export async function getCache(url: string): Promise<CacheEntry | null> {
  const key = await keyForUrl(url);
  const res = await chrome.storage.local.get(key);
  return (res[key] as CacheEntry | undefined) ?? null;
}

export async function setCache(url: string, entry: CacheEntry): Promise<void> {
  const key = await keyForUrl(url);
  await chrome.storage.local.set({ [key]: entry });
}

export async function deleteCache(url: string): Promise<void> {
  const key = await keyForUrl(url);
  await chrome.storage.local.remove(key);
}

export async function getApiKey(): Promise<string | null> {
  const res = await chrome.storage.local.get("apiKey");
  return (res.apiKey as string | undefined) ?? null;
}

export async function setApiKey(apiKey: string): Promise<void> {
  await chrome.storage.local.set({ apiKey });
}

export async function getOffsetSeconds(): Promise<number> {
  const res = await chrome.storage.local.get("offsetSeconds");
  const v = Number(res.offsetSeconds);
  return Number.isFinite(v) ? v : 0;
}

export async function setOffsetSeconds(offsetSeconds: number): Promise<void> {
  await chrome.storage.local.set({ offsetSeconds });
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
