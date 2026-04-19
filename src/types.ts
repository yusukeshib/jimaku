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

export type ExtensionMessage = ContentReady | SubtitleDetected | TabReset;
