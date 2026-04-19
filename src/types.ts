export type Cue = {
  start: number;
  end: number;
  text: string;
};

export type TranslatedCue = {
  start: number;
  end: number;
  ja: string;
};

export type CacheEntry = {
  translatedAt: number;
  model: string;
  cues: TranslatedCue[];
};

export type SubtitleDetected = {
  type: "SUBTITLE_DETECTED";
  url: string;
};

export type TranslateRequest = {
  type: "TRANSLATE_REQUEST";
  url: string;
  vtt: string;
};

export type TranslateProgress = {
  type: "TRANSLATE_PROGRESS";
  done: number;
  total: number;
};

export type TranslateDone = {
  type: "TRANSLATE_DONE";
  cues: TranslatedCue[];
};

export type TranslateError = {
  type: "TRANSLATE_ERROR";
  error: string;
};

export type ExtensionMessage =
  | SubtitleDetected
  | TranslateRequest
  | TranslateProgress
  | TranslateDone
  | TranslateError;
