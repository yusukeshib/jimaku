import { defineManifest } from "@crxjs/vite-plugin";
import { allContentScriptMatches, allHostPermissions } from "./src/platforms";

const API_HOSTS = [
  "https://api.anthropic.com/*",
  "https://api.openai.com/*",
  "https://openrouter.ai/*",
];

export default defineManifest({
  manifest_version: 3,
  name: "Jimaku",
  version: "1.0.2",
  description: "AI subtitle translation for Prime Video. Unofficial — not affiliated with Amazon.",
  default_locale: "en",
  permissions: ["storage", "webRequest", "webNavigation", "identity"],
  host_permissions: [...allHostPermissions(), ...API_HOSTS],
  icons: {
    16: "icons/icon-16.png",
    32: "icons/icon-32.png",
    48: "icons/icon-48.png",
    128: "icons/icon-128.png",
  },
  background: {
    service_worker: "src/background.ts",
    type: "module",
  },
  content_scripts: [
    {
      matches: allContentScriptMatches(),
      js: ["src/content.ts"],
      run_at: "document_idle",
    },
  ],
  action: {
    default_title: "Jimaku",
    default_popup: "src/popup/popup.html",
    default_icon: {
      16: "icons/icon-16.png",
      32: "icons/icon-32.png",
      48: "icons/icon-48.png",
      128: "icons/icon-128.png",
    },
  },
  options_ui: {
    page: "src/cache/cache.html",
    open_in_tab: true,
  },
});
