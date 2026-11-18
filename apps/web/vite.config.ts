import lingui from "@lingui/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
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

export default defineConfig({
  plugins: [react(), tailwindcss(), lingui({ macroTransform: true })],
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
