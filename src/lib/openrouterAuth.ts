const AUTH_URL = "https://openrouter.ai/auth";
const EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";
const KEY_CHECK_URL = "https://openrouter.ai/api/v1/key";

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomVerifier(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function sha256(s: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

function extractCode(redirectedUrl: string): string {
  const u = new URL(redirectedUrl);
  const code = u.searchParams.get("code");
  if (!code) throw new Error("OpenRouter did not return an authorization code.");
  return code;
}

export async function connectOpenRouter(): Promise<string> {
  const verifier = randomVerifier();
  const challenge = base64UrlEncode(await sha256(verifier));
  const redirectUri = chrome.identity.getRedirectURL();

  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set("callback_url", redirectUri);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  const redirected = await new Promise<string>((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true }, (result) => {
      const lastErr = chrome.runtime.lastError;
      if (lastErr) return reject(new Error(lastErr.message || "Sign-in cancelled."));
      if (!result) return reject(new Error("Sign-in cancelled."));
      resolve(result);
    });
  });

  const code = extractCode(redirected);

  const res = await fetch(EXCHANGE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenRouter token exchange failed (${res.status}): ${body || "no body"}`);
  }
  const data = (await res.json()) as { key?: unknown };
  if (typeof data.key !== "string" || !data.key) {
    throw new Error("OpenRouter token exchange returned no key.");
  }

  // Verify the fresh key actually maps to a user before declaring success —
  // a key that fails here would only surface later as an opaque 401
  // ("User not found") on the first translation request.
  const check = await fetch(KEY_CHECK_URL, {
    headers: { authorization: `Bearer ${data.key}` },
  });
  if (!check.ok) {
    const body = await check.text().catch(() => "");
    throw new Error(
      `OpenRouter issued a key but it failed validation (${check.status}): ${body.slice(0, 200) || "no body"}. Try connecting again.`,
    );
  }

  return data.key;
}
