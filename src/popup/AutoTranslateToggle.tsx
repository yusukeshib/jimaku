import { useEffect, useState } from "react";
import { getEnabled, setEnabled } from "../lib/cache";
import { t } from "../lib/i18n";

export function AutoTranslateToggle() {
  const [on, setOn] = useState(true);

  useEffect(() => {
    void getEnabled().then(setOn);
  }, []);

  return (
    <div className="toggle" style={{ marginTop: 4 }}>
      <label htmlFor="enabled">{t("label_auto_translate")}</label>
      <input
        id="enabled"
        type="checkbox"
        checked={on}
        onChange={(e) => {
          const next = e.target.checked;
          setOn(next);
          void setEnabled(next);
        }}
      />
    </div>
  );
}
