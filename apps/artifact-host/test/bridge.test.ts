import { runInNewContext } from "node:vm"
import {
  ARTIFACT_HEIGHT_MAX,
  ARTIFACT_HEIGHT_MIN,
  ARTIFACT_RESULT_MAX_BYTES,
  ARTIFACT_RESULT_TITLE_MAX,
} from "@openchat/contracts"
import { describe, expect, it, vi } from "vitest"
import { SANDBOX_POLICY, documentPolicy } from "../src/app"
import { BRIDGE_SCRIPT } from "../src/bridge"
import {
  brokenSource,
  calculatorSource,
  cdnSource,
  chartSource,
  externalScriptSources,
  rejectsRemoteReference,
  remoteReferences,
} from "./fixtures"

/**
 * The shim is shipped as text, so it is tested as text: a minimal window and
 * document run it in a fresh VM context. No browser, no network and no jsdom —
 * the same conditions as the portable document.
 */
interface Posted {
  message: Record<string, unknown>
  target: string
}

interface Harness {
  openchat: Openchat
  posted: Posted[]
  reload: ReturnType<typeof vi.fn>
  documentElement: { setAttribute: ReturnType<typeof vi.fn>; style: Record<string, string> }
  dispatch(data: unknown, source?: unknown): void
  resize(height: number): void
}

interface Openchat {
  theme: string
  locale: string
  onInit(fn: (info: { theme: string; locale: string }) => void): void
  result(payload: unknown): boolean
  setHeight(px: unknown): boolean
}

function harness(): Harness {
  const posted: Posted[] = []
  const listeners: Array<(event: { source: unknown; data: unknown }) => void> = []
  const parent = {
    postMessage: (message: Record<string, unknown>, target: string) => {
      posted.push({ message, target })
    },
  }
  const reload = vi.fn()
  const documentElement = {
    setAttribute: vi.fn(),
    style: {} as Record<string, string>,
  }
  const root = { getBoundingClientRect: () => ({ height: 200 }) }
  const document = {
    readyState: "complete",
    documentElement,
    getElementById: (id: string) => (id === "root" ? root : null),
    addEventListener: vi.fn(),
  }

  const observers: Array<{
    callback: (entries: Array<{ contentRect: { height: number } }>) => void
    target: unknown
  }> = []

  class ResizeObserver {
    private readonly callback: (entries: Array<{ contentRect: { height: number } }>) => void
    constructor(callback: (entries: Array<{ contentRect: { height: number } }>) => void) {
      this.callback = callback
    }
    observe(target: unknown) {
      observers.push({ callback: this.callback, target })
    }
    disconnect() {}
  }

  const window = {
    parent,
    location: { reload },
    addEventListener: (type: string, listener: (event: never) => void) => {
      if (type === "message") listeners.push(listener as never)
    },
  }

  runInNewContext(BRIDGE_SCRIPT, {
    window,
    document,
    ResizeObserver,
    TextEncoder,
    JSON,
    Math,
    Object,
    Number,
    Array,
    isFinite,
    Infinity,
  })

  const openchat = (window as unknown as { openchat: Openchat }).openchat
  return {
    openchat,
    posted,
    reload,
    documentElement,
    dispatch(data: unknown, source: unknown = parent) {
      for (const listener of listeners) listener({ source, data })
    },
    resize(height: number) {
      const observer = observers[0]
      if (!observer) throw new Error("no ResizeObserver installed")
      observer.callback([{ contentRect: { height } }])
    },
  }
}

const INIT = { type: "artifact:init", id: "a".repeat(64), nonce: "n-1", theme: "dark", locale: "de" }
/**
 * Protocol pin from `docs/implementation/18-artifact-bridge.md` "Limits", in
 * code points. The shim reads the cap from `@openchat/contracts`; this literal
 * makes a silent wire change fail here instead of passing unnoticed.
 */
const TITLE_MAX = 200

describe("artifact bridge shim", () => {
  it("installs exactly the documented API and sends nothing before init", () => {
    const host = harness()
    expect(Object.keys(host.openchat).sort()).toEqual([
      "locale",
      "onInit",
      "result",
      "setHeight",
      "theme",
    ])
    expect(host.openchat.theme).toBe("light")
    expect(host.openchat.locale).toBe("en")

    // No nonce yet: every send is refused, and no message leaves the frame.
    expect(host.openchat.result({ text: "early" })).toBe(false)
    expect(host.openchat.setHeight(300)).toBe(false)
    expect(host.posted).toEqual([])
  })

  it("accepts artifact:init only from window.parent", () => {
    const host = harness()
    host.dispatch(INIT, { name: "not-the-parent" })
    expect(host.posted).toEqual([])
    expect(host.openchat.theme).toBe("light")

    host.dispatch(INIT)
    expect(host.posted.map((entry) => entry.message.type)).toEqual([
      "artifact:ready",
      "artifact:resize",
    ])
    expect(host.posted[0]?.message).toEqual({ type: "artifact:ready", nonce: "n-1" })
    expect(host.posted[0]?.target).toBe("*")
    expect(host.openchat.theme).toBe("dark")
    expect(host.openchat.locale).toBe("de")
    expect(host.documentElement.setAttribute).toHaveBeenCalledWith("data-theme", "dark")
    expect(host.documentElement.style.colorScheme).toBe("dark")
  })

  it("answers onInit immediately after init and queues it before", () => {
    const host = harness()
    const early: Array<{ theme: string; locale: string }> = []
    host.openchat.onInit((info) => early.push(info))
    expect(early).toEqual([])

    host.dispatch(INIT)
    expect(early).toEqual([{ theme: "dark", locale: "de" }])

    const late: Array<{ theme: string; locale: string }> = []
    host.openchat.onInit((info) => late.push(info))
    expect(late).toEqual([{ theme: "dark", locale: "de" }])
  })

  it("posts a validated result with the nonce and refuses wrong shapes or oversize", () => {
    const host = harness()
    host.dispatch(INIT)
    host.posted.length = 0

    expect(host.openchat.result(null)).toBe(false)
    expect(host.openchat.result("text")).toBe(false)
    expect(host.openchat.result({ title: 7 })).toBe(false)
    expect(host.openchat.result({ text: 7 })).toBe(false)
    expect(host.posted).toEqual([])

    expect(host.openchat.result({ title: "T", text: "hello", data: { n: 1 } })).toBe(true)
    expect(host.posted).toEqual([
      {
        message: {
          type: "artifact:result",
          nonce: "n-1",
          title: "T",
          text: "hello",
          data: { n: 1 },
        },
        target: "*",
      },
    ])

    host.posted.length = 0
    // 65 KiB of text is over the cap; the frame keeps it instead of posting.
    expect(host.openchat.result({ text: "x".repeat(65 * 1024) })).toBe(false)
    expect(host.posted).toEqual([])
  })

  it("truncates a result title by code points, like the viewer", () => {
    const host = harness()
    host.dispatch(INIT)
    host.posted.length = 0

    // 199 ASCII characters plus one emoji: a UTF-16 slice would keep a lone
    // high surrogate as the 200th unit, which the viewer would then drop.
    const title = `${"a".repeat(TITLE_MAX - 1)}😀`
    expect(host.openchat.result({ title })).toBe(true)

    const posted = host.posted[0]?.message.title as string
    expect(Array.from(posted)).toHaveLength(TITLE_MAX)
    expect(posted.endsWith("😀")).toBe(true)
    expect(posted.length).toBe(TITLE_MAX + 1)
  })

  it("observes #root and clamps setHeight to the documented band", () => {
    const host = harness()
    host.resize(320)
    // Before init the height is remembered but not sent.
    expect(host.posted).toEqual([])

    host.dispatch(INIT)
    host.posted.length = 0
    host.resize(321.6)
    expect(host.posted).toEqual([
      { message: { type: "artifact:resize", height: 322, nonce: "n-1" }, target: "*" },
    ])

    host.posted.length = 0
    expect(host.openchat.setHeight(10)).toBe(true)
    expect(host.openchat.setHeight(9000)).toBe(true)
    expect(host.openchat.setHeight("tall")).toBe(false)
    expect(host.posted.map((entry) => entry.message.height)).toEqual([80, 4000])
  })

  it("only reloads on artifact:reset with the current nonce", () => {
    const host = harness()
    host.dispatch({ type: "artifact:reset", nonce: "n-1" })
    expect(host.reload).not.toHaveBeenCalled()

    host.dispatch(INIT)
    host.dispatch({ type: "artifact:reset", nonce: "wrong" })
    expect(host.reload).not.toHaveBeenCalled()
    host.dispatch({ type: "artifact:reset", nonce: "n-1" }, { name: "elsewhere" })
    expect(host.reload).not.toHaveBeenCalled()

    host.dispatch({ type: "artifact:reset", nonce: "n-1" })
    expect(host.reload).toHaveBeenCalledTimes(1)
  })

  it("carries no token, storage or network primitive", () => {
    expect(BRIDGE_SCRIPT).not.toContain("</script")
    for (const forbidden of [
      "fetch(",
      "XMLHttpRequest",
      "WebSocket",
      "EventSource",
      "sendBeacon",
      "eval(",
      "new Function",
      "document.cookie",
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "window.open(",
      "window.top",
      "import(",
      "require(",
    ]) {
      expect(BRIDGE_SCRIPT).not.toContain(forbidden)
    }
  })

  it("is built from the contract's caps instead of retyping them", () => {
    // The declarations the shim runs carry the values @openchat/contracts
    // owns. Comparing against the constants (not a literal) is what makes a
    // contract change flow into the emitted script; the viewer imports the
    // same module.
    expect(BRIDGE_SCRIPT).toContain(`var RESULT_MAX_BYTES = ${ARTIFACT_RESULT_MAX_BYTES};`)
    expect(BRIDGE_SCRIPT).toContain(`var TITLE_MAX = ${ARTIFACT_RESULT_TITLE_MAX};`)
    expect(BRIDGE_SCRIPT).toContain(`var RESIZE_MIN = ${ARTIFACT_HEIGHT_MIN};`)
    expect(BRIDGE_SCRIPT).toContain(`var RESIZE_MAX = ${ARTIFACT_HEIGHT_MAX};`)
  })
})

describe("egress and self-navigation proofs", () => {
  it("keeps top navigation and same-origin out of the sandbox policy", () => {
    expect(SANDBOX_POLICY).toBe("sandbox allow-scripts")
    expect(SANDBOX_POLICY).not.toContain("allow-top-navigation")
    expect(SANDBOX_POLICY).not.toContain("allow-same-origin")
    expect(SANDBOX_POLICY).not.toContain("allow-popups")
  })

  it("denies every network path in the document policy", () => {
    const policy = documentPolicy("https://chat.example.com")
    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain("connect-src 'none'")
    expect(policy).toContain("script-src 'unsafe-inline'")
    expect(policy).not.toContain("'self'")
    // A remote <script src> has no allowed source: only inline script runs.
    expect(policy).not.toMatch(/script-src[^;]*https?:/)
  })

  it("rejects the cdn fixture and would never load its script", () => {
    expect(externalScriptSources(cdnSource)).toEqual(["https://cdn.example.com/chart.js"])
    expect(remoteReferences(cdnSource)).toContain("https://cdn.example.com/chart.js")
    expect(rejectsRemoteReference(cdnSource)).toBe(true)
    expect(rejectsRemoteReference(calculatorSource)).toBe(false)
    expect(rejectsRemoteReference(chartSource)).toBe(false)
  })
})

describe("fixtures", () => {
  it("calculator drives a slider, radios and result()", () => {
    expect(calculatorSource).toContain('type="range"')
    expect(calculatorSource).toContain('type="radio"')
    expect(calculatorSource).toContain("aria-live")
    expect(calculatorSource).toContain("openchat.result(")
  })

  it("chart draws local data as SVG and reports its height", () => {
    expect(chartSource).toContain("<svg")
    expect(chartSource).toContain('role="img"')
    expect(chartSource).toContain("openchat.setHeight(")
    expect(remoteReferences(chartSource)).toEqual([])
  })

  it("broken throws on mount and cdn is final HTML with a remote script", () => {
    expect(brokenSource).toContain("throw new Error")
    expect(cdnSource).toContain("<!-- Final HTML")
    expect(cdnSource).toContain("<script src=")
  })
})
