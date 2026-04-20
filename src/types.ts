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
};

export type Status = "idle" | "detected" | "translating" | "ready" | "error";

export type StateSnapshot = {
  status: Status;
  progress: { done: number; total: number } | null;
  error: string | null;
  hasSubtitle: boolean;
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

export type PopupStart = {
  type: "POPUP_START";
};

export type PopupRegenerate = {
  type: "POPUP_REGENERATE";
};

export type StateUpdate = {
  type: "STATE_UPDATE";
  state: StateSnapshot;
};

export type ExtensionMessage =
  | ContentReady
  | SubtitleDetected
  | TabReset
  | PopupGetState
  | PopupStart
  | PopupRegenerate
  | StateUpdate;
