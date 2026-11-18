import { ARTIFACT_CODE_MAX_BYTES, ARTIFACT_CSS_MAX_BYTES } from "@openchat/contracts"
import { describe, expect, it } from "vitest"
import { findViolation, kib, validateAppInput } from "../src/validate"

/**
 * The JSX validator table from
 * `docs/architecture/07-artifact-runtime.md`. Every row is one construct the
 * tool must reject before it compiles anything.
 */

const APP = `function App() {
  const [count, setCount] = useState(0)
  return <button onClick={() => setCount(count + 1)}>{count}</button>
}`

function withPrefix(line: string): string {
  return `${line}\n${APP}`
}

function rejection(input: unknown): string {
  const result = validateAppInput(input)
  if (result.ok) throw new Error("expected a rejection")
  return result.error
}

describe("validator: accepted input", () => {
  it("accepts one top-level function App", () => {
    const result = validateAppInput({ title: "  Counter  ", code: APP })
    expect(result).toEqual({ ok: true, value: { title: "Counter", code: APP, css: "" } })
  })

  it.each([
    ["a const arrow component", "const App = () => <div>ok</div>"],
    ["an async function", "async function App() { return <div>ok</div> }"],
    ["a class component", "class App { render() { return <div>ok</div> } }"],
    ["an exported function", "export function App() { return <div>ok</div> }"],
  ])("accepts %s", (_label, code) => {
    expect(validateAppInput({ title: "app", code }).ok).toBe(true)
  })

  it("accepts CSS and treats null as absent", () => {
    expect(validateAppInput({ title: "app", code: APP, css: "body { color: red }" })).toMatchObject({
      ok: true,
      value: { css: "body { color: red }" },
    })
    expect(validateAppInput({ title: "app", code: APP, css: null })).toMatchObject({
      ok: true,
      value: { css: "" },
    })
  })

  it("does not treat the // comment marker as a URL", () => {
    expect(validateAppInput({ title: "app", code: withPrefix("// offline by design") }).ok).toBe(
      true,
    )
  })

  it("accepts a data URI image", () => {
    const code = withPrefix(
      'const logo = "data:image/svg+xml;base64,PHN2Zy8+"',
    )
    expect(validateAppInput({ title: "app", code }).ok).toBe(true)
  })
})

describe("validator: imports", () => {
  it.each([
    ["a static import", 'import { useState } from "preact"', "import: line 1"],
    ["a bare import", 'import "preact"', "import: line 1"],
    ["a dynamic import", 'const lazy = () => import("preact")', "dynamic-import: line 1"],
    ["require", 'const preact = require("preact")', "require: line 1"],
  ])("rejects %s", (_label, line, message) => {
    expect(rejection({ title: "app", code: withPrefix(line) })).toBe(message)
  })
})

describe("validator: network constructs", () => {
  it.each([
    ["fetch", 'await fetch("/api")', "fetch: line 1"],
    ["globalThis.fetch", 'await globalThis.fetch("/api")', "fetch: line 1"],
    ["XMLHttpRequest", "const xhr = new XMLHttpRequest()", "XMLHttpRequest: line 1"],
    ["WebSocket", 'const socket = new WebSocket("wss://x")', "WebSocket: line 1"],
    ["EventSource", 'const events = new EventSource("/events")', "EventSource: line 1"],
    ["sendBeacon", 'navigator.sendBeacon("/collect", "x")', "sendBeacon: line 1"],
    ["an http URL", 'const src = "http://cdn.example/x.js"', "cdn-url: line 1"],
    ["an https URL", 'const src = "https://cdn.example/x.js"', "cdn-url: line 1"],
    ["a protocol-relative URL", 'const src = "//cdn.example/x.js"', "cdn-url: line 1"],
  ])("rejects %s", (_label, line, message) => {
    expect(rejection({ title: "app", code: withPrefix(line) })).toBe(message)
  })
})

describe("validator: code execution", () => {
  it.each([
    ["eval", 'eval("1 + 1")', "eval: line 1"],
    ["new Function", 'const run = new Function("return 1")', "new Function: line 1"],
    ["document.write", 'document.write("<p>hi</p>")', "document.write: line 1"],
    ["document.writeln", 'document.writeln("hi")', "document.write: line 1"],
    ["</script", 'const closing = "</script>"', "shell-injection: line 1"],
  ])("rejects %s", (_label, line, message) => {
    expect(rejection({ title: "app", code: withPrefix(line) })).toBe(message)
  })
})

describe("validator: storage and window", () => {
  it.each([
    ["localStorage", 'localStorage.setItem("a", "b")', "localStorage: line 1"],
    ["sessionStorage", 'sessionStorage.setItem("a", "b")', "sessionStorage: line 1"],
    ["indexedDB", "const db = indexedDB.open(\"a\")", "indexedDB: line 1"],
    ["document.cookie", 'const cookie = document.cookie', "document.cookie: line 1"],
    ["window.open", 'window.open("/dialog")', "window.open: line 1"],
    ["window.top", "window.top.location.reload()", "window.top: line 1"],
    ["window.parent", "window.parent.postMessage({}, '*')", "window.parent: line 1"],
  ])("rejects %s", (_label, line, message) => {
    expect(rejection({ title: "app", code: withPrefix(line) })).toBe(message)
  })
})

describe("validator: css", () => {
  it.each([
    ["an @import", '@import "theme.css";', "import: line 1"],
    ["an https font URL", 'body { background: url("https://cdn.example/bg.png") }', "cdn-url: line 1"],
    ["a closing script tag", 'body::after { content: "</script>" }', "shell-injection: line 1"],
    ["a closing style tag", 'body::after { content: "</style><script>x</script>" }', "shell-injection: line 1"],
  ])("rejects %s", (_label, css, message) => {
    expect(rejection({ title: "app", code: APP, css })).toBe(message)
  })
})

describe("validator: structure", () => {
  it.each([
    ["a missing App", "const app = () => <div>ok</div>", "app: no top-level function App found"],
    ["an inline nested App", "function Outer() { function App() { return 1 } }", "app: no top-level function App found"],
  ])("rejects %s", (_label, code, message) => {
    expect(rejection({ title: "app", code })).toBe(message)
  })

  it("rejects a non-object input", () => {
    expect(rejection("function App() {}")).toBe("input: expected an object with title and code")
    expect(rejection(null)).toBe("input: expected an object with title and code")
  })

  it.each([
    ["a missing title", { code: APP }, "title: must be a string"],
    ["a blank title", { title: "   ", code: APP }, "title: must not be empty"],
    ["a non-string code", { title: "app", code: 42 }, "code: must be a string"],
    ["a blank code", { title: "app", code: "  \n " }, "code: must not be empty"],
    ["a non-string css", { title: "app", code: APP, css: 7 }, "css: must be a string"],
  ])("rejects %s", (_label, input, message) => {
    expect(rejection(input)).toBe(message)
  })

  it("rejects a title over 120 code points", () => {
    expect(rejection({ title: "a".repeat(121), code: APP })).toBe("title: 121 characters > 120")
    const emoji = validateAppInput({ title: "🎉".repeat(120), code: APP })
    expect(emoji.ok).toBe(true)
  })

  it("reports the first violation by line", () => {
    const code = `const a = 1\nconst b = 2\nfetch("/x")\nlocalStorage.setItem("k", "v")`
    expect(rejection({ title: "app", code })).toBe("fetch: line 3")
  })
})

describe("validator: size caps", () => {
  it("accepts exactly 64 KiB of code", () => {
    const padding = "x".repeat(ARTIFACT_CODE_MAX_BYTES - APP.length - 4)
    const code = `${APP}\n// ${padding}`
    expect(Buffer.byteLength(code, "utf8")).toBe(ARTIFACT_CODE_MAX_BYTES)
    expect(validateAppInput({ title: "app", code }).ok).toBe(true)
  })

  it("rejects one byte over 64 KiB", () => {
    const padding = "x".repeat(ARTIFACT_CODE_MAX_BYTES - APP.length - 3)
    const code = `${APP}\n// ${padding}`
    expect(Buffer.byteLength(code, "utf8")).toBe(ARTIFACT_CODE_MAX_BYTES + 1)
    expect(rejection({ title: "app", code })).toBe("size: 65 KiB > 64 KiB")
  })

  it("counts UTF-8 bytes, not characters", () => {
    const code = `${APP}\n// ${"ä".repeat(40_000)}`
    expect(rejection({ title: "app", code })).toBe("size: 79 KiB > 64 KiB")
  })

  it("caps CSS at 32 KiB", () => {
    const css = `/* ${"x".repeat(ARTIFACT_CSS_MAX_BYTES)} */`
    expect(rejection({ title: "app", code: APP, css })).toBe("size: css 33 KiB > 32 KiB")
  })
})

describe("validator: helpers", () => {
  it("rounds a byte count up to KiB", () => {
    expect(kib(0)).toBe(0)
    expect(kib(1)).toBe(1)
    expect(kib(1024)).toBe(1)
    expect(kib(1025)).toBe(2)
    expect(kib(65_536)).toBe(64)
  })

  it("returns the first hit and nothing for clean text", () => {
    expect(findViolation("ok")).toBeNull()
    expect(findViolation("a\nb\nfetch(1)")).toEqual({ label: "fetch", line: 3 })
  })
})
