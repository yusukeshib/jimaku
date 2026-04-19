import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "Prime JA Subs",
  version: "0.1.0",
  description: "Amazon Prime Video の英語字幕を Claude で日本語に翻訳してオーバーレイ表示",
  permissions: ["storage", "webRequest", "webNavigation", "scripting"],
  host_permissions: [
    "*://*.amazon.com/*",
    "*://*.amazon.co.jp/*",
    "*://*.primevideo.com/*",
    "*://*.media-amazon.com/*",
    "*://*.pv-cdn.net/*",
    "*://*.aiv-cdn.net/*",
    "https://api.anthropic.com/*",
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
  options_page: "src/options/options.html",
  action: {
    default_title: "Prime JA Subs",
  },
});
