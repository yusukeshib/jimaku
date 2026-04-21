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
  version: "0.1.0",
  description: "Translate Prime Video and Netflix subtitles with AI and overlay them on the player",
  default_locale: "en",
  permissions: ["storage", "webRequest", "webNavigation", "scripting", "identity"],
  host_permissions: [...allHostPermissions(), ...API_HOSTS],
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
  },
});
