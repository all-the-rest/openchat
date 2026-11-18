import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { afterEach, vi } from "vitest"
import { reportNetworkSuccess } from "../src/pwa/offline"
import { setStreamActive } from "../src/pwa/stream-guard"

// Component tests exercise UI behaviour, not transport. Without a stub, jsdom's
// failed relative fetches would legitimately flip the shell's offline signal.
vi.stubGlobal(
  "fetch",
  vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
)

afterEach(() => {
  cleanup()
  reportNetworkSuccess()
  setStreamActive(false)
  window.localStorage.clear()
  window.sessionStorage.clear()
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.lang = "en"
})

if (typeof window.matchMedia !== "function") {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: vi.fn(async () => undefined),
    readText: vi.fn(async () => ""),
  },
})
