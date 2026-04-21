// Keys must match the entries in public/_locales/<lang>/messages.json.
// Kept as a union so the compiler catches typos and missing keys.
export type MessageKey =
  | "tagline"
  | "status_checking"
  | "status_open_streaming_page"
  | "status_auto_translate_off"
  | "status_something_went_wrong"
  | "status_translating"
  | "status_subtitles_ready"
  | "status_subtitle_detected"
  | "status_waiting_for_subtitle"
  | "label_auto_translate"
  | "label_target_language"
  | "label_show_translated"
  | "label_hide_original"
  | "label_translation_provider"
  | "label_api_key"
  | "button_save"
  | "button_connect_openrouter"
  | "label_connected_openrouter"
  | "button_disconnect"
  | "msg_api_key_empty"
  | "msg_saved"
  | "msg_opening_openrouter"
  | "msg_connected"
  | "msg_disconnected"
  | "msg_signin_cancelled"
  | "link_get_a_key"
  | "hint_key_storage";

export function t(key: MessageKey, substitutions?: Array<string | number>): string {
  const subs = substitutions?.map(String);
  const msg = chrome.i18n.getMessage(key, subs);
  // Loud fallback so a missing translation is visible during dev instead of
  // silently rendering an empty label.
  return msg || `[${key}]`;
}
