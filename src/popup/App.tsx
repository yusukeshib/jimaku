import { useEffect, useState } from "react";
import { DEFAULT_TARGET_LANGUAGE, getProvider, getTargetLanguage } from "../lib/cache";
import { t } from "../lib/i18n";
import type { ProviderId } from "../lib/providers";
import type { ExtensionMessage, PopupGetState, StateSnapshot } from "../types";
import { AutoTranslateToggle } from "./AutoTranslateToggle";
import { LanguageSelect } from "./LanguageSelect";
import { ModelLabel } from "./ModelLabel";
import { OverlayToggles } from "./OverlayToggles";
import { ProviderSection } from "./ProviderSection";
import { StatusRow } from "./StatusRow";

export function App() {
  const [provider, setProvider] = useState<ProviderId>("openrouter");
  const [language, setLanguage] = useState<string>(DEFAULT_TARGET_LANGUAGE);
  const [snapshot, setSnapshot] = useState<StateSnapshot | null>(null);
  const [reachable, setReachable] = useState(true);

  // Initial hydration from storage.
  useEffect(() => {
    void getProvider().then(setProvider);
    void getTargetLanguage().then(setLanguage);
  }, []);

  // Ping the active tab's content script for current state, and listen for
  // streaming updates. If the active tab isn't a Prime Video page (no content
  // script), mark unreachable so the status row can render the hint.
  useEffect(() => {
    let cancelled = false;
    let activeTabId: number | null = null;
    let contentHeard = false;

    const onMessage = (raw: ExtensionMessage, sender: chrome.runtime.MessageSender) => {
      if (raw.type !== "STATE_UPDATE") return;
      if (sender.tab?.id !== activeTabId) return;
      contentHeard = true;
      setSnapshot(raw.state);
      setReachable(true);
    };
    chrome.runtime.onMessage.addListener(onMessage);

    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (cancelled) return;
      if (!tab?.id) {
        setReachable(false);
        return;
      }
      activeTabId = tab.id;
      const msg: PopupGetState = { type: "POPUP_GET_STATE" };
      try {
        await chrome.tabs.sendMessage(activeTabId, msg);
      } catch {
        setReachable(false);
        return;
      }
      // Give the content script a moment to reply; if it doesn't, treat as
      // unreachable (Prime Video page present but content script not mounted,
      // e.g. a different origin).
      window.setTimeout(() => {
        if (!cancelled && !contentHeard) setReachable(false);
      }, 500);
    })();

    return () => {
      cancelled = true;
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, []);

  return (
    <div className="wrap">
      <h1>Jimaku</h1>
      <p className="sub">{t("tagline")}</p>

      <StatusRow snapshot={snapshot} reachable={reachable} language={language} />

      <AutoTranslateToggle />

      <LanguageSelect value={language} onChange={setLanguage} />

      <OverlayToggles />

      <ProviderSection provider={provider} onProviderChange={setProvider} />

      <ModelLabel provider={provider} language={language} />
    </div>
  );
}
