import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "Jimaku",
  version: "0.1.0",
  description: "Translate Amazon Prime Video subtitles with Claude and overlay them on the player",
  default_locale: "en",
  permissions: ["storage", "webRequest", "webNavigation", "scripting", "identity"],
  host_permissions: [
    "*://*.amazon.com/*",
    "*://*.amazon.co.jp/*",
    "*://*.primevideo.com/*",
    "*://*.media-amazon.com/*",
    "*://*.pv-cdn.net/*",
    "*://*.aiv-cdn.net/*",
    "https://api.anthropic.com/*",
    "https://api.openai.com/*",
    "https://openrouter.ai/*",
  ],
  background: {
    service_worker: "src/background.ts",
    type: "module",
  },
  content_scripts: [
    {
      matches: [
        "*://*.amazon.com/gp/video/*",
        "*://*.amazon.com/dp/*",
        "*://*.amazon.co.jp/gp/video/*",
        "*://*.amazon.co.jp/dp/*",
        "*://*.primevideo.com/*",
      ],
      js: ["src/content.ts"],
      run_at: "document_idle",
    },
  ],
  action: {
    default_title: "Jimaku",
    default_popup: "src/popup/popup.html",
  },
});
