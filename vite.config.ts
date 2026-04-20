// @ts-expect-error — @types/node isn't installed; we only need this at build-time.
import { execSync } from "node:child_process";
// @ts-expect-error — see above.
import { watch as fsWatch } from "node:fs";
import { crx } from "@crxjs/vite-plugin";
import { defineConfig, type Plugin } from "vite";
import manifest from "./manifest.config";

function buildVersion(): string {
  try {
    const sha = execSync("git rev-parse --short HEAD").toString().trim();
    const dirty = execSync("git status --porcelain").toString().trim().length > 0;
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
}

// Restart the dev server when git HEAD advances so the SHA displayed in the
// popup (__BUILD_VERSION__) tracks the current commit without manual restarts.
function watchGitHead(): Plugin {
  return {
    name: "watch-git-head",
    configureServer(server) {
      const paths = [".git/HEAD", ".git/logs/HEAD"];
      const watchers: Array<{ close(): void }> = [];
      for (const p of paths) {
        try {
          watchers.push(
            fsWatch(p, () => {
              server.config.logger.info(`[jimaku] ${p} changed — restarting`);
              void server.restart();
            }),
          );
        } catch {}
      }
      server.httpServer?.on("close", () => {
        for (const w of watchers) w.close();
      });
    },
  };
}

export default defineConfig({
  plugins: [crx({ manifest }), watchGitHead()],
  define: {
    __BUILD_VERSION__: JSON.stringify(buildVersion()),
  },
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
