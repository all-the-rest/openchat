import {
  ARTIFACT_CODE_MAX_BYTES,
  ARTIFACT_CSS_MAX_BYTES,
  ARTIFACT_TITLE_MAX,
} from "@openchat/contracts"

/**
 * The JSX validator from
 * [`07-artifact-runtime.md`](../../../docs/architecture/07-artifact-runtime.md).
 * It runs before the compiler so every rejection carries a line number and a
 * construct name the model can act on. The sandbox and the CSP stay the
 * backstop; this module exists for good error messages and deterministic
 * output. It has no I/O and no compiler dependency.
 */

/** One rejected construct. `label` names it; `line` is 1-based. */
export interface Violation {
  label: string
  line: number
}

interface Rule {
  label: string
  pattern: RegExp
}

/**
 * Every pattern is global because `matchAll` needs it. Hits inside comments or
 * strings count as hits: a construct that only appears in a comment still says
 * the author was about to use it, and a table of exceptions is a bypass.
 */
const CODE_RULES: readonly Rule[] = [
  { label: "import", pattern: /(?<![\w$.])import\s+(?!\()/g },
  { label: "dynamic-import", pattern: /(?<![\w$.])import\s*\(/g },
  // `\b` instead of a lookbehind: `globalThis.fetch(` must match as well as a
  // bare `fetch(`. Rejecting `obj.fetch(` too is the safe direction.
  { label: "require", pattern: /\brequire\s*\(/g },
  { label: "fetch", pattern: /\bfetch\s*\(/g },
  { label: "XMLHttpRequest", pattern: /\bXMLHttpRequest\b/g },
  { label: "WebSocket", pattern: /\bWebSocket\b/g },
  { label: "EventSource", pattern: /\bEventSource\b/g },
  { label: "sendBeacon", pattern: /\bnavigator\s*\.\s*sendBeacon\b/g },
  // A URL literal is a CDN, a remote image or an exfiltration target. The
  // quoted form catches protocol-relative URLs (`"//cdn.example"`) without
  // flagging the `//` comment marker.
  { label: "cdn-url", pattern: /https?:/gi },
  { label: "cdn-url", pattern: /(["'`])\/\/[A-Za-z0-9]/g },
  { label: "eval", pattern: /\beval\s*\(/g },
  { label: "new Function", pattern: /\bnew\s+Function\b/g },
  { label: "document.write", pattern: /\bdocument\s*\.\s*write(?:ln)?\b/g },
  { label: "localStorage", pattern: /\blocalStorage\b/g },
  { label: "sessionStorage", pattern: /\bsessionStorage\b/g },
  { label: "indexedDB", pattern: /\bindexedDB\b/g },
  { label: "document.cookie", pattern: /\bdocument\s*\.\s*cookie\b/g },
  { label: "window.open", pattern: /\bwindow\s*\.\s*open\b/g },
  { label: "window.top", pattern: /\bwindow\s*\.\s*top\b/g },
  { label: "window.parent", pattern: /\bwindow\s*\.\s*parent\b/g },
  { label: "shell-injection", pattern: /<\/script/gi },
]

/**
 * CSS is inlined into a `<style>` element, so `</style` ends the element just
 * like `</script` ends the script. The architecture lists only `</script` for
 * both inputs; the `</style` half is added here because otherwise a stylesheet
 * could append markup.
 */
const CSS_RULES: readonly Rule[] = [
  { label: "import", pattern: /@import\b/gi },
  { label: "cdn-url", pattern: /https?:/gi },
  { label: "cdn-url", pattern: /(["'`])\/\/[A-Za-z0-9]/g },
  { label: "shell-injection", pattern: /<\/(?:script|style)/gi },
]

/** A declaration of `App` at the start of a line, optionally exported. */
const APP_DECLARATION =
  /^[ \t]*(?:export\s+)?(?:async\s+)?function\s+App\s*[({]|^[ \t]*(?:export\s+)?(?:const|let|var)\s+App\s*=|^[ \t]*(?:export\s+)?class\s+App\s*\{/m

export interface ValidatedApp {
  /** Trimmed title, still capped by the store at 120 code points. */
  title: string
  code: string
  /** Empty when the caller sent no CSS. */
  css: string
}

export type ValidationResult =
  | { ok: true; value: ValidatedApp }
  | { ok: false; error: string }

export function kib(bytes: number): number {
  return Math.ceil(bytes / 1024)
}

function bytesOf(text: string): number {
  return Buffer.byteLength(text, "utf8")
}

function lineAt(text: string, index: number): number {
  let line = 1
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1
  }
  return line
}

/** The earliest hit wins; on one line, the earlier rule in the table wins. */
export function findViolation(text: string, rules: readonly Rule[] = CODE_RULES): Violation | null {
  let best: Violation | null = null
  for (const rule of rules) {
    // A fresh regex per rule keeps `lastIndex` out of the picture, and the
    // first match of each rule is all we need: a later hit cannot be earlier
    // than the first one, and line numbers grow with the index.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags)
    const match = pattern.exec(text)
    if (!match) continue
    const line = lineAt(text, match.index)
    if (!best || line < best.line) best = { label: rule.label, line }
  }
  return best
}

function formatViolation(violation: Violation): string {
  return `${violation.label}: line ${violation.line}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Validates the raw tool arguments. The order is deliberate: shape and size
 * first (cheap and the most common failure), then constructs, then the `App`
 * declaration, so a model gets one decisive message instead of a list.
 */
export function validateAppInput(input: unknown): ValidationResult {
  if (!isRecord(input)) return { ok: false, error: "input: expected an object with title and code" }

  const { title, code, css } = input
  if (typeof title !== "string") return { ok: false, error: "title: must be a string" }
  const trimmedTitle = title.trim()
  if (trimmedTitle.length === 0) return { ok: false, error: "title: must not be empty" }
  const titleLength = [...trimmedTitle].length
  if (titleLength > ARTIFACT_TITLE_MAX) {
    return { ok: false, error: `title: ${titleLength} characters > ${ARTIFACT_TITLE_MAX}` }
  }

  if (typeof code !== "string") return { ok: false, error: "code: must be a string" }
  if (code.trim().length === 0) return { ok: false, error: "code: must not be empty" }
  const codeBytes = bytesOf(code)
  if (codeBytes > ARTIFACT_CODE_MAX_BYTES) {
    return {
      ok: false,
      error: `size: ${kib(codeBytes)} KiB > ${kib(ARTIFACT_CODE_MAX_BYTES)} KiB`,
    }
  }

  if (css !== undefined && css !== null && typeof css !== "string") {
    return { ok: false, error: "css: must be a string" }
  }
  const stylesheet = typeof css === "string" ? css : ""
  const cssBytes = bytesOf(stylesheet)
  if (cssBytes > ARTIFACT_CSS_MAX_BYTES) {
    return {
      ok: false,
      error: `size: css ${kib(cssBytes)} KiB > ${kib(ARTIFACT_CSS_MAX_BYTES)} KiB`,
    }
  }

  const codeViolation = findViolation(code, CODE_RULES)
  if (codeViolation) return { ok: false, error: formatViolation(codeViolation) }

  const cssViolation = findViolation(stylesheet, CSS_RULES)
  if (cssViolation) return { ok: false, error: formatViolation(cssViolation) }

  if (!APP_DECLARATION.test(code)) {
    return { ok: false, error: "app: no top-level function App found" }
  }

  return { ok: true, value: { title: trimmedTitle, code, css: stylesheet } }
}
