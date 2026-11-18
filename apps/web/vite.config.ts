import { createHash } from "node:crypto"
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import lingui from "@lingui/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import type { Plugin } from "vite"
import { defineConfig } from "vitest/config"

const BFF_TARGET = process.env.OPENCHAT_BFF_TARGET ?? "http://localhost:8787"

/**
 * Syntax highlighting is the single largest renderer dependency family
 * (~150 kB minified: `highlight.js` plus `lowlight`, once per-language grammars
 * included). It belongs to chat only and is loaded alongside the lazy
 * `ChatPage` chunk; a named group keeps it below the 500 kB chunk gate that
 * `scripts/check-bundle.ts` enforces instead of forcing one oversized chunk.
 */
const HIGHLIGHT_MODULES =
  /[\\/]node_modules[\\/](?:\.pnpm[\\/])?(?:highlight\.js|lowlight)(?:@|[\\/])/

const WEB_DIR = dirname(fileURLToPath(import.meta.url))
const DIST_DIR = join(WEB_DIR, "dist")
const SW_SOURCE = join(WEB_DIR, "public", "sw.js")

/**
 * Injects a content-derived version and the exact precache list into the
 * hand-written service worker. Hashing the build manifest means the same source
 * always produces the same version; any asset change produces a new one, which
 * is the signal the in-app "reload to update" notice watches for.
 */
function serviceWorkerVersion(): Plugin {
  return {
    name: "openchat-sw-version",
    apply: "build",
    closeBundle() {
      const manifestPath = join(DIST_DIR, ".vite", "manifest.json")
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
        string,
        { file: string }
      >
      const assets = [...new Set(Object.values(manifest).map((chunk) => `/${chunk.file}`))].sort()
      const icons = readdirSync(join(WEB_DIR, "public", "icons"))
        .filter((name) => name.endsWith(".png"))
        .map((name) => `/icons/${name}`)
        .sort()
      const precache = [...new Set(["/", "/index.html", "/manifest.webmanifest", ...icons, ...assets])]
      const version = createHash("sha256").update(JSON.stringify(manifest)).digest("hex").slice(0, 12)

      let source = readFileSync(SW_SOURCE, "utf8")
      source = source.replace('const VERSION = "dev"', `const VERSION = ${JSON.stringify(version)}`)
      source = source.replace(/const PRECACHE = \[[^\]]*\]/, `const PRECACHE = ${JSON.stringify(precache)}`)
      if (!source.includes(`const VERSION = "${version}"`) || source.includes('"dev"')) {
        throw new Error("service worker version injection failed: placeholders not found")
      }
      writeFileSync(join(DIST_DIR, "sw.js"), source)
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), lingui({ macroTransform: true }), serviceWorkerVersion()],
  build: {
    // `scripts/check-bundle.ts` reads the manifest to tell the eager route
    // shell apart from lazily imported route and renderer chunks.
    manifest: true,
    // The only chunks still above 500 kB are in Mermaid's lazy graph (ELK
    // ~1.5 MB, parser core ~629 kB), fetched when a diagram renders. The
    // enforced gate is `scripts/check-bundle.ts` (500 kB, Mermaid graph
    // exempt); this advisory limit only keeps a green build warning-free.
    chunkSizeWarningLimit: 1600,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: "renderer-highlight", test: HIGHLIGHT_MODULES }],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: BFF_TARGET, changeOrigin: false },
      "/healthz": { target: BFF_TARGET, changeOrigin: false },
    },
  },
  preview: {
    port: 4173,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
    css: false,
    clearMocks: true,
    restoreMocks: true,
  },
})
