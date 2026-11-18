import lingui from "@lingui/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

const BFF_TARGET = "http://localhost:8787"

export default defineConfig({
  plugins: [react(), tailwindcss(), lingui({ macroTransform: true })],
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
