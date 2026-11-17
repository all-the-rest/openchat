/**
 * Literal UI-string gate (ADR-0003, spec 12).
 *
 * Scans the web components for user-visible literals that bypass the message
 * catalogue. Deliberately narrow: it checks JSX text nodes (also across line
 * breaks) and the attributes that are read by users or assistive tech, plus a
 * short allowlist of DOM sinks in `.ts` files. It does not try to catch every
 * string.
 *
 * Escape hatch: a line containing `i18n-ignore` is skipped, and files under
 * `src/i18n/` (the catalogues) are not scanned.
 *
 * `--target=<dir>` points the scan at another tree; the tests use it to check
 * the gate against a temporary fixture. `--count` prints the finding count and
 * always exits successfully for the ratchet.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const ROOT = new URL("..", import.meta.url).pathname
const targetArgument = process.argv
  .slice(2)
  .find((argument) => argument.startsWith("--target="))
const TARGET = targetArgument
  ? resolve(targetArgument.slice("--target=".length))
  : join(ROOT, "apps/web/src")

const ATTRIBUTES = ["aria-label", "aria-description", "placeholder", "title", "alt"]
const ATTRIBUTE_RE = new RegExp(
  `\\b(${ATTRIBUTES.join("|")})\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
  "g",
)

/** `.ts` sinks where a literal is user-visible or announced by a screen reader. */
const DOCUMENT_TITLE_RE = /\bdocument\.title\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const SET_ATTRIBUTE_RE = new RegExp(
  `\\bsetAttribute\\(\\s*(?:"(${ATTRIBUTES.join("|")})"|'(${ATTRIBUTES.join("|")})')` +
    `\\s*,\\s*(?:"([^"]*)"|'([^']*)')\\s*\\)`,
  "g",
)

interface Tag {
  closing: boolean
  name: string
  start: number
  end: number
  source: string
}

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) files(path, out)
    else if (/\.(tsx|jsx|ts)$/.test(entry)) out.push(path)
  }
  return out
}

function hasWord(value: string): boolean {
  return /[A-Za-zÄÖÜäöüß]{2,}/.test(value)
}

function lineNumber(text: string, index: number): number {
  let line = 1
  for (let offset = 0; offset < index && offset < text.length; offset += 1) {
    if (text[offset] === "\n") line += 1
  }
  return line
}

/**
 * Returns the index just after the `>` that closes the tag at `start`, or -1
 * when this `<` is not a tag (a comparison, a generic without an end). Braces
 * and quoted attribute values may contain `>`/`<`; a nested `<` at depth 0
 * means this is not one flat tag (e.g. `element={<Foo />}`).
 */
function findTagEnd(text: string, start: number, limit = text.length): number {
  let depth = 0
  let quote: string | undefined
  for (let index = start + 1; index < limit; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === "{") {
      depth += 1
      continue
    }
    if (char === "}") {
      depth -= 1
      continue
    }
    if (char === "<" && depth === 0) return -1
    if (char === ">" && depth === 0) return index + 1
  }
  return -1
}

/** Returns the index just after the `}` that closes the expression at `start`. */
function findBraceEnd(text: string, start: number, limit: number): number {
  let depth = 0
  let quote: string | undefined
  for (let index = start; index < limit; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === "{") depth += 1
    else if (char === "}") {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return -1
}

function scanTags(text: string): Tag[] {
  const tags: Tag[] = []
  let cursor = 0
  while (cursor < text.length) {
    const start = text.indexOf("<", cursor)
    if (start === -1) break
    const next = text[start + 1] ?? ""
    if (!/[A-Za-z/>]/.test(next)) {
      cursor = start + 1
      continue
    }
    const end = findTagEnd(text, start)
    if (end === -1) {
      cursor = start + 1
      continue
    }
    const source = text.slice(start, end)
    const name = /^<\/?([A-Za-z][\w.:-]*)?/.exec(source)?.[1] ?? ""
    tags.push({ closing: source.startsWith("</"), name, start, end, source })
    cursor = end
  }
  return tags
}

/** Text ranges inside `[start, end)` that are neither a tag nor an expression. */
function textSegments(text: string, start: number, end: number): Array<[number, number]> {
  const segments: Array<[number, number]> = []
  let cursor = start
  let index = start
  while (index < end) {
    const char = text[index]
    if (char === "<") {
      const tagEnd = findTagEnd(text, index, end)
      if (tagEnd !== -1) {
        segments.push([cursor, index])
        cursor = tagEnd
        index = tagEnd
        continue
      }
    } else if (char === "{") {
      const braceEnd = findBraceEnd(text, index, end)
      if (braceEnd !== -1) {
        segments.push([cursor, index])
        cursor = braceEnd
        index = braceEnd
        continue
      }
    }
    index += 1
  }
  segments.push([cursor, end])
  return segments
}

function countLiteralStrings(): string[] {
  const findings: string[] = []
  const seen = new Set<string>()

  for (const file of files(TARGET)) {
    const rel = relative(ROOT, file)
    const local = relative(TARGET, file).split("\\").join("/")
    if (local.startsWith("i18n/")) continue

    const text = readFileSync(file, "utf8")
    const lines = text.split("\n")
    const ignored = lines.map(
      (line) => line.includes("i18n-ignore") || /^\s*(\/\/|\*|\/\*)/.test(line),
    )
    const report = (index: number, message: string, endIndex = index): void => {
      const start = lineNumber(text, index)
      const end = lineNumber(text, endIndex)
      for (let line = start; line <= end; line += 1) {
        if (ignored[line - 1]) return
      }
      const finding = `${rel}:${start}  ${message}`
      if (seen.has(finding)) return
      seen.add(finding)
      findings.push(finding)
    }

    if (/\.(tsx|jsx)$/.test(file)) {
      const stack: Tag[] = []
      for (const tag of scanTags(text)) {
        if (!tag.closing) {
          if (!tag.source.endsWith("/>")) stack.push(tag)
          for (const attribute of tag.source.matchAll(ATTRIBUTE_RE)) {
            const value = attribute[2] ?? attribute[3] ?? ""
            if (hasWord(value) && attribute.index !== undefined) {
              report(tag.start + attribute.index, `attribute ${attribute[1]}="${value}"`)
            }
          }
          continue
        }

        let index = stack.length - 1
        while (index >= 0 && stack[index]?.name !== tag.name) index -= 1
        if (index === -1) continue
        const open = stack[index]
        stack.length = index
        if (!open) continue
        for (const [segmentStart, segmentEnd] of textSegments(text, open.end, tag.start)) {
          const raw = text.slice(segmentStart, segmentEnd)
          const value = raw.trim()
          if (value.length <= 1 || !hasWord(value)) continue
          const leading = raw.length - raw.trimStart().length
          report(segmentStart + leading, `text "${value}"`, segmentEnd)
        }
      }
    }

    if (/\.ts$/.test(file)) {
      for (const match of text.matchAll(DOCUMENT_TITLE_RE)) {
        const value = match[1] ?? match[2] ?? ""
        if (hasWord(value) && match.index !== undefined) {
          report(match.index, `sink document.title="${value}"`)
        }
      }

      for (const match of text.matchAll(SET_ATTRIBUTE_RE)) {
        const name = match[1] ?? match[2] ?? "attribute"
        const value = match[3] ?? match[4] ?? ""
        if (hasWord(value) && match.index !== undefined) {
          report(match.index, `sink setAttribute(${name})="${value}"`)
        }
      }
    }
  }

  return findings
}

const findings = countLiteralStrings()

// Ratchet counter mode: a bare integer and a successful exit, also when the
// count is non-zero. The default mode below stays the gate.
if (process.argv.includes("--count")) {
  console.log(findings.length)
  process.exit(0)
}

if (findings.length > 0) {
  console.error("Literal UI strings found (use useT() and src/i18n/messages):")
  for (const finding of findings) console.error(`  ${finding}`)
  console.error(
    `\n${findings.length} finding(s). Add the key to en.ts and de.ts, or mark the line with i18n-ignore.`,
  )
  process.exit(1)
}

console.log("i18n: no literal UI strings")
