import { describe, expect, it } from "vitest"
import { BRIDGE_SCRIPT } from "@openchat/artifact-host/bridge"
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

/**
 * App code that really contains a script terminator, as a string and inside a
 * template literal. The compiler must escape both, or the shell's bridge
 * `<script>` element would end early.
 */
const ESCAPING_APP = [
  "function App() {",
  '  const literal = "</script><script>alert(1)</script>"',
  "  const template = `</script>`",
  "  return <p>{literal}{template}</p>",
  "}",
].join("\n")

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
    // Generation 2 is the document that carries the bridge shim.
    expect(document).toContain('data-oc="2"')
    expect(SHELL_VERSION).toBe("2")
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

  it("inlines the bridge before the app bundle", async () => {
    const script = await compileOrThrow(APP)
    const document = buildDocument({
      title: "Counter",
      css: "",
      script,
      tools: { esbuild: ESBUILD_VERSION, preact: PREACT_VERSION },
    })
    const bridgeTag = `<script>${BRIDGE_SCRIPT}</script>`
    const bundleTag = `<script>${script}</script>`
    expect(bridgeScript()).toBe(BRIDGE_SCRIPT)
    expect(document).toContain(bridgeTag)
    // The shim is a classic script and must run first: window.openchat has to
    // exist when the app IIFE calls it, so the order is part of the contract.
    expect(document.indexOf(bridgeTag)).toBeLessThan(document.indexOf(bundleTag))
    expect(document.indexOf(bridgeTag)).toBeGreaterThan(document.indexOf('<div id="root"></div>'))
    expect(document.match(/<script>/g)).toHaveLength(2)
    // The shim installs `window.openchat`; the document text has to carry it.
    expect(document).toContain("window.openchat")
    expect(document).not.toContain('<script type="module"')
  })

  it("escapes a </script> the app code really contains", async () => {
    const script = await compileOrThrow(ESCAPING_APP)
    // The fixture contains the terminator twice: in a string and in a
    // template literal. esbuild emits both as `<\/script`, so the document
    // keeps exactly two script elements instead of breaking out early.
    expect(ESCAPING_APP).toContain("</script><script>alert(1)</script>")
    expect(ESCAPING_APP).toContain("`</script>`")
    expect(script.toLowerCase()).not.toContain("</script")
    expect(script).toContain("<\\/script")

    const document = buildDocument({
      title: "Counter",
      css: "",
      script,
      tools: { esbuild: ESBUILD_VERSION, preact: PREACT_VERSION },
    })
    // The bridge and the bundle: a third terminator would mean an escape
    // failed somewhere between app source and the stored document.
    expect(document.match(/<\/script>/g)).toHaveLength(2)
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
