import type { CacheEntry } from "../types";

const PREFIX = "sub:";

async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

export async function getApiKey(): Promise<string | null> {
  const res = await chrome.storage.local.get("apiKey");
  return (res.apiKey as string | undefined) ?? null;
}

export async function setApiKey(apiKey: string): Promise<void> {
  await chrome.storage.local.set({ apiKey });
}
