export type Cue = {
  start: number;
  end: number;
  text: string;
};

export type TranslatedCue = {
  start: number;
  end: number;
  text: string;
};

export type CacheEntry = {
  translatedAt: number;
  model: string;
  cues: TranslatedCue[];
  sourceCues?: Cue[];
  // Undefined on legacy entries — treat as complete. False while translation
  // is mid-stream; true once the final cache write lands.
  complete?: boolean;
};

export type TranslationPhase = "idle" | "translating" | "complete" | "error";

export type PlaybackState = "absent" | "paused" | "playing";

export type StateSnapshot = {
  translation: {
    phase: TranslationPhase;
    progress: { done: number; total: number } | null;
    error: string | null;
  };
  playback: PlaybackState;
  hasSubtitle: boolean;
  enabled: boolean;
  title: string | null;
};

export type ContentReady = {
  type: "CONTENT_READY";
};

export type SubtitleDetected = {
  type: "SUBTITLE_DETECTED";
  url: string;
};

export type TabReset = {
  type: "TAB_RESET";
};

export type PopupGetState = {
  type: "POPUP_GET_STATE";
};

export type StateUpdate = {
  type: "STATE_UPDATE";
  state: StateSnapshot;
};

export type OpenRouterConnect = {
  type: "OPENROUTER_CONNECT";
};

export type OpenRouterConnectResult = { ok: true } | { ok: false; error: string };

/**
 * Content-script-initiated OpenSubtitles lookup. Routed through the background
 * service worker because MV3 content scripts are subject to CORS even with
 * host_permissions; the service worker isn't.
 */
export type OpenSubtitlesFetch = {
  type: "OPENSUBTITLES_FETCH";
  query: string;
  language: string;
  minCues: number;
};

export type OpenSubtitlesFetchResult =
  | { ok: true; srt: string | null }
  | { ok: false; error: string };

export type ExtensionMessage =
  | ContentReady
  | SubtitleDetected
  | TabReset
  | PopupGetState
  | StateUpdate
  | OpenRouterConnect
  | OpenSubtitlesFetch;
