import { useEffect, useRef, useState } from "react";
import { clearProviderKey, getProviderKey, setProvider, setProviderKey } from "../lib/cache";
import { t } from "../lib/i18n";
import { PROVIDERS, type ProviderId } from "../lib/providers";
import type { OpenRouterConnect, OpenRouterConnectResult } from "../types";

type Props = {
  provider: ProviderId;
  onProviderChange: (id: ProviderId) => void;
};

type StatusKind = "ok" | "error" | null;

export function ProviderSection({ provider, onProviderChange }: Props) {
  const meta = PROVIDERS[provider];
  const [storedKey, setStoredKey] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [status, setStatus] = useState<{ text: string; kind: StatusKind }>({
    text: "",
    kind: null,
  });
  const [connecting, setConnecting] = useState(false);
  const statusTimerRef = useRef<number | null>(null);

  const flashStatus = (text: string, kind: StatusKind, clearAfterMs = 2500) => {
    if (statusTimerRef.current !== null) window.clearTimeout(statusTimerRef.current);
    setStatus({ text, kind });
    if (text && clearAfterMs > 0) {
      statusTimerRef.current = window.setTimeout(
        () => setStatus({ text: "", kind: null }),
        clearAfterMs,
      );
    }
  };

  // Load the stored key when provider changes, and clear stale UI status.
  useEffect(() => {
    let cancelled = false;
    void getProviderKey(provider).then((k) => {
      if (cancelled) return;
      setStoredKey(k);
      setInputValue(k ?? "");
    });
    setStatus({ text: "", kind: null });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  // When the SW-driven OAuth flow lands a key, reflect it here even if the
  // popup was open the whole time.
  useEffect(() => {
    const onChanged = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: chrome.storage.AreaName,
    ) => {
      if (area !== "local") return;
      if (provider === "openrouter" && changes.openrouterKey) {
        const v = changes.openrouterKey.newValue;
        setStoredKey(typeof v === "string" && v ? v : null);
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [provider]);

  useEffect(() => {
    return () => {
      if (statusTimerRef.current !== null) window.clearTimeout(statusTimerRef.current);
    };
  }, []);

  const handleProviderChange = (next: ProviderId) => {
    onProviderChange(next);
    void setProvider(next);
  };

  const handleSave = async () => {
    const key = inputValue.trim();
    if (!key) {
      flashStatus(t("msg_api_key_empty"), "error");
      return;
    }
    await setProviderKey(provider, key);
    setStoredKey(key);
    flashStatus(t("msg_saved"), "ok");
  };

  const handleConnect = () => {
    setConnecting(true);
    flashStatus(t("msg_opening_openrouter"), "ok", 0);
    const msg: OpenRouterConnect = { type: "OPENROUTER_CONNECT" };
    chrome.runtime.sendMessage(msg, (raw?: OpenRouterConnectResult) => {
      setConnecting(false);
      const lastErr = chrome.runtime.lastError;
      if (lastErr || !raw) {
        // Popup likely survived; silence. storage.onChanged will surface the
        // key if it lands later.
        setStatus({ text: "", kind: null });
        return;
      }
      if (raw.ok) {
        flashStatus(t("msg_connected"), "ok");
      } else {
        flashStatus(raw.error || t("msg_signin_cancelled"), "error");
      }
    });
  };

  const handleDisconnect = async () => {
    await clearProviderKey("openrouter");
    setStoredKey(null);
    setInputValue("");
    flashStatus(t("msg_disconnected"), "ok");
  };

  return (
    <div className="api-row">
      <label htmlFor="provider">{t("label_translation_provider")}</label>
      <select
        id="provider"
        value={provider}
        onChange={(e) => handleProviderChange(e.target.value as ProviderId)}
      >
        <option value="anthropic">Anthropic (Claude)</option>
        <option value="openai">OpenAI (GPT)</option>
        <option value="openrouter">OpenRouter</option>
      </select>

      {provider !== "openrouter" && (
        <div>
          <label htmlFor="apiKey">{t("label_api_key")}</label>
          <div className="row">
            <input
              id="apiKey"
              type="password"
              placeholder={meta.keyPlaceholder}
              autoComplete="off"
              spellCheck={false}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
            />
            <button type="button" onClick={handleSave}>
              {t("button_save")}
            </button>
          </div>
        </div>
      )}

      {provider === "openrouter" && storedKey && (
        <div className="connected">
          <span className="label">{t("label_connected_openrouter")}</span>
          <button type="button" className="link-btn" onClick={handleDisconnect}>
            {t("button_disconnect")}
          </button>
        </div>
      )}

      {provider === "openrouter" && !storedKey && (
        <button type="button" className="secondary" onClick={handleConnect} disabled={connecting}>
          {t("button_connect_openrouter")}
        </button>
      )}

      <p className={`saved${status.kind === "error" ? " error" : ""}`}>{status.text}</p>
      <p className="hint">
        <a href={meta.keyHelpUrl} target="_blank" rel="noopener">
          {t("link_get_a_key")}
        </a>{" "}
        · {t("hint_key_storage")}
      </p>
    </div>
  );
}
