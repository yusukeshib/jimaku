import { useEffect, useState } from "react";
import {
  getHideOriginal,
  getShowTranslated,
  setHideOriginal,
  setShowTranslated,
} from "../lib/cache";
import { t } from "../lib/i18n";

export function OverlayToggles() {
  const [showTranslated, setShowTranslatedState] = useState(true);
  const [hideOriginal, setHideOriginalState] = useState(false);

  useEffect(() => {
    void getShowTranslated().then(setShowTranslatedState);
    void getHideOriginal().then(setHideOriginalState);
  }, []);

  return (
    <div className="toggles">
      <div className="toggle">
        <label htmlFor="showTranslated">{t("label_show_translated")}</label>
        <input
          id="showTranslated"
          type="checkbox"
          checked={showTranslated}
          onChange={(e) => {
            const v = e.target.checked;
            setShowTranslatedState(v);
            void setShowTranslated(v);
          }}
        />
      </div>
      <div className="toggle">
        <label htmlFor="hideOriginal">{t("label_hide_original")}</label>
        <input
          id="hideOriginal"
          type="checkbox"
          checked={hideOriginal}
          onChange={(e) => {
            const v = e.target.checked;
            setHideOriginalState(v);
            void setHideOriginal(v);
          }}
        />
      </div>
    </div>
  );
}
