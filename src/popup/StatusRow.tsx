import { t } from "../lib/i18n";
import type { StateSnapshot } from "../types";

type Props = {
  snapshot: StateSnapshot | null;
  reachable: boolean;
  language: string;
};

type View = {
  dotClass: "idle" | "active" | "error";
  label: string;
  progressPct: number | null;
  errorMessage: string | null;
  title: string | null;
};

function deriveView(snapshot: StateSnapshot, language: string): View {
  if (!snapshot.enabled) {
    return {
      dotClass: "idle",
      label: t("status_auto_translate_off"),
      progressPct: null,
      errorMessage: null,
      title: snapshot.title,
    };
  }
  if (!snapshot.providerReady) {
    return {
      dotClass: "idle",
      label: t("status_provider_setup_needed"),
      progressPct: null,
      errorMessage: null,
      title: snapshot.title,
    };
  }
  const tr = snapshot.translation;
  if (tr.phase === "error") {
    return {
      dotClass: "error",
      label: t("status_something_went_wrong"),
      progressPct: null,
      errorMessage: tr.error,
      title: snapshot.title,
    };
  }
  if (tr.phase === "translating") {
    const p = tr.progress;
    const done = p?.done ?? 0;
    const total = p?.total ?? 0;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    return {
      dotClass: "active",
      label: t("status_translating", [done, total || "?", pct]),
      progressPct: pct,
      errorMessage: null,
      title: snapshot.title,
    };
  }
  if (tr.phase === "complete") {
    return {
      dotClass: "active",
      label: t("status_subtitles_ready", [language]),
      progressPct: null,
      errorMessage: null,
      title: snapshot.title,
    };
  }
  if (snapshot.hasSubtitle) {
    return {
      dotClass: "active",
      label: t("status_subtitle_detected"),
      progressPct: null,
      errorMessage: null,
      title: snapshot.title,
    };
  }
  return {
    dotClass: "active",
    label: t("status_waiting_for_subtitle"),
    progressPct: null,
    errorMessage: null,
    title: snapshot.title,
  };
}

export function StatusRow({ snapshot, reachable, language }: Props) {
  if (!reachable) {
    return (
      <div className="status-row">
        <span className="dot idle" />
        <span>{t("status_open_streaming_page")}</span>
      </div>
    );
  }
  if (!snapshot) {
    return (
      <div className="status-row">
        <span className="dot idle" />
        <span>{t("status_checking")}</span>
      </div>
    );
  }
  const v = deriveView(snapshot, language);
  return (
    <>
      <div className="status-row">
        <span className={`dot ${v.dotClass}`} />
        <span>{v.label}</span>
      </div>
      {v.title ? (
        <p className="sub" style={{ margin: "-4px 0 10px" }}>
          {v.title}
        </p>
      ) : null}
      {v.progressPct !== null ? (
        <div className="bar">
          <div style={{ width: `${v.progressPct}%` }} />
        </div>
      ) : null}
      {v.errorMessage ? <p className="err">{v.errorMessage}</p> : null}
    </>
  );
}
