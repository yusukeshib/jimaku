import { crx } from "@crxjs/vite-plugin";
import { defineConfig } from "vite";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    target: "esnext",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
    cors: {
      origin: /chrome-extension:\/\/.+/,
    },
  },
});
