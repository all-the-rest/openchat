/**
 * Literal UI-string gate (ADR-0003, spec 12).
 *
 * Scans the web components for user-visible literals that bypass the message
 * catalogue. Deliberately narrow: it checks JSX text nodes and the attributes
 * that are read by users or assistive tech, not every string in the file.
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
const JSX_TEXT_RE = />([^<>{}]+)</g

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) files(path, out)
    else if (/\.(tsx|jsx)$/.test(entry)) out.push(path)
  }
  return out
}

function hasWord(value: string): boolean {
  return /[A-Za-zÄÖÜäöüß]{2,}/.test(value)
}

function countLiteralStrings(): string[] {
  const findings: string[] = []

  for (const file of files(TARGET)) {
    const rel = relative(ROOT, file)
    const local = relative(TARGET, file).split("\\").join("/")
    if (local.startsWith("i18n/")) continue
    const lines = readFileSync(file, "utf8").split("\n")
    lines.forEach((line, index) => {
      if (line.includes("i18n-ignore")) return
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return

      for (const match of line.matchAll(ATTRIBUTE_RE)) {
        const value = match[2] ?? match[3] ?? ""
        if (hasWord(value)) {
          findings.push(`${rel}:${index + 1}  attribute ${match[1]}="${value}"`)
        }
      }

      for (const match of line.matchAll(JSX_TEXT_RE)) {
        const value = (match[1] ?? "").trim()
        if (value.length > 1 && hasWord(value)) {
          findings.push(`${rel}:${index + 1}  text "${value}"`)
        }
      }
    })
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
