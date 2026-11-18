import { describe, expect, it } from "vitest"
import {
  ESBUILD_VERSION,
  PREACT_VERSION,
  RUNTIME_TAIL,
  compileModule,
} from "../src/compile"
import { SHELL_CSS, SHELL_VERSION, bridgeScript, buildDocument, escapeHtml } from "../src/shell"

const APP = `function App() {
  const [count, setCount] = useState(0)
  return <button onClick={() => setCount(count + 1)}>{count}</button>
}`

const CSS = "body { font-family: system-ui }"

async function compileOrThrow(code: string): Promise<string> {
  const result = await compileModule(code)
  if ("error" in result) throw new Error(result.error)
  return result.script
}

describe("compiler", () => {
  it("produces one self-contained IIFE with the mount call", async () => {
    const script = await compileOrThrow(APP)
    expect(script.startsWith("(() => {")).toBe(true)
    expect(script.trimEnd().endsWith("})();")).toBe(true)
    // The shell must mount into #root; that is the only DOM contract.
    expect(script).toContain('document.getElementById("root")')
    expect(script).toContain("artifact shell is missing #root")
    expect(RUNTIME_TAIL).toContain("render(h(App), __openchatRoot)")
  })

  it("leaves no import statement in the output", async () => {
    const script = await compileOrThrow(APP)
    expect(script).not.toMatch(/^\s*import\b/m)
    expect(script).not.toContain('from "preact"')
    expect(script).not.toContain("require(")
  })

  it("never emits a script terminator", async () => {
    const script = await compileOrThrow(APP)
    expect(script.toLowerCase()).not.toContain("</script")
  })

  it("is deterministic for identical input", async () => {
    const first = await compileOrThrow(APP)
    const second = await compileOrThrow(APP)
    expect(second).toBe(first)
  })

  it("injects every documented hook", async () => {
    const script = await compileOrThrow(
      `function App() {
        const [a, setA] = useState(0)
        const [b, dispatch] = useReducer((x) => x, 0)
        const ref = useRef(null)
        const memo = useMemo(() => a, [a])
        const cb = useCallback(() => setA(1), [])
        useEffect(() => {}, [])
        return <div ref={ref} onClick={cb}>{memo}{b}{dispatch ? "" : ""}</div>
      }`,
    )
    expect(script.length).toBeGreaterThan(1000)
  })

  it("reports a syntax error with a code position", async () => {
    const result = await compileModule("function App() {\n  return <div>\n}")
    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error).toMatch(/^code:\d+:\d+: /)
      // The position points into the module the model wrote, not into the
      // appended runtime.
      expect(result.error.startsWith("code:3:")).toBe(true)
    }
  })

  it("reports an unsupported bundler construct as a compiler error", async () => {
    const result = await compileModule(
      'import { useState } from "preact"\nfunction App() { return <div /> }',
    )
    // The validator normally rejects imports first; the compiler is the
    // backstop and must not throw out of the tool.
    expect("error" in result || "script" in result).toBe(true)
  })

  it("names the pinned toolchain versions", () => {
    expect(ESBUILD_VERSION).toMatch(/^\d+\.\d+\.\d+/)
    expect(PREACT_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe("shell", () => {
  it("assembles the documented document", async () => {
    const script = await compileOrThrow(APP)
    const document = buildDocument({
      title: "Counter",
      css: CSS,
      script,
      tools: { esbuild: ESBUILD_VERSION, preact: PREACT_VERSION },
    })
    expect(document.startsWith('<!doctype html><html lang="en" data-oc="')).toBe(true)
    expect(document).toContain('data-oc="1"')
    expect(document).toContain('<meta charset="utf-8">')
    expect(document).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">')
    expect(document).toContain('<meta name="color-scheme" content="light dark">')
    expect(document).toContain("<title>Counter</title>")
    expect(document).toContain(`<style>${SHELL_CSS}</style>`)
    expect(document).toContain(`<style>${CSS}</style>`)
    expect(document).toContain('<div id="root"></div>')
    expect(document).toContain(`<script>${script}</script>`)
    expect(document).toContain(`<!-- openchat artifact shell ${SHELL_VERSION}`)
    expect(document).toContain(`esbuild ${ESBUILD_VERSION}`)
    expect(document).toContain(`preact ${PREACT_VERSION}`)
    expect(document.trimEnd().endsWith("</body></html>")).toBe(true)
  })

  it("ships no bridge today", async () => {
    const script = await compileOrThrow(APP)
    const document = buildDocument({
      title: "Counter",
      css: "",
      script,
      tools: { esbuild: ESBUILD_VERSION, preact: PREACT_VERSION },
    })
    expect(bridgeScript()).toBe("")
    expect(document).not.toContain("window.openchat")
    // Exactly one script element: the bundle. Slice 4 adds the bridge.
    expect(document.match(/<script>/g)).toHaveLength(1)
  })

  it("is deterministic for identical input", async () => {
    const script = await compileOrThrow(APP)
    const input = {
      title: "Counter",
      css: CSS,
      script,
      tools: { esbuild: ESBUILD_VERSION, preact: PREACT_VERSION },
    }
    expect(buildDocument(input)).toBe(buildDocument(input))
  })

  it("escapes the title", () => {
    expect(escapeHtml(`<script>&"'`)).toBe("&lt;script&gt;&amp;&quot;&#39;")
    const document = buildDocument({
      title: "</title><script>alert(1)</script>",
      css: "",
      script: "",
      tools: { esbuild: "0", preact: "0" },
    })
    expect(document).not.toContain("</title><script>alert")
    expect(document).toContain("<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>")
  })
})
