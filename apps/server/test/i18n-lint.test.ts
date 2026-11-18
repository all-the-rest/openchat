import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

const SCRIPT = join(import.meta.dirname, "..", "..", "..", "scripts", "lint-i18n.ts")
const created: string[] = []

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "openchat-i18n-"))
  created.push(root)
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name)
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, contents)
  }
  return root
}

function lint(root: string) {
  return spawnSync(process.execPath, [SCRIPT, `--target=${root}`], {
    encoding: "utf8",
  })
}

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("lint-i18n gate", () => {
  it("fails on a literal JSX string", () => {
    const root = fixture({
      "src/Component.tsx": "export function C() {\n  return <p>Hello there</p>\n}\n",
    })
    const result = lint(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Component.tsx")
    expect(result.stderr).toContain("Hello there")
  })

  it("passes when the string comes from the catalogue", () => {
    const root = fixture({
      "src/Component.tsx": [
        "export function C() {",
        '  return <p>{t("greeting")}</p>',
        "}",
        "",
      ].join("\n"),
      "src/i18n/messages.tsx": [
        "export const messages = {",
        '  greeting: "Hello there",',
        "}",
        "",
      ].join("\n"),
    })
    const result = lint(root)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("no literal UI strings")
  })

  it("fails on a JSX text node that spans lines", () => {
    const root = fixture({
      "src/Component.tsx": [
        "export function C() {",
        "  return (",
        "    <p>",
        "      Hello there",
        "    </p>",
        "  )",
        "}",
        "",
      ].join("\n"),
    })
    const result = lint(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Component.tsx:4")
    expect(result.stderr).toContain("Hello there")
  })

  it("fails on a DOM sink in a .ts file", () => {
    const root = fixture({
      "src/title.ts": [
        "export function setTitle() {",
        '  document.title = "Hello there"',
        "}",
        "",
      ].join("\n"),
      "src/label.ts": [
        "export function label(element: HTMLElement) {",
        '  element.setAttribute("aria-label", "Hello there")',
        "}",
        "",
      ].join("\n"),
    })
    const result = lint(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("title.ts:2")
    expect(result.stderr).toContain("label.ts:2")
    expect(result.stderr).toContain("Hello there")
  })

  it("does not flag generic types or expression comparisons", () => {
    const root = fixture({
      "src/Component.tsx": [
        "export function C(): Promise<void> {",
        "  const ok = 1 > 0",
        "  return (",
        "    <p>{ok ? <strong>{t(\"yes\")}</strong> : null}</p>",
        "  )",
        "}",
        "",
      ].join("\n"),
    })
    const result = lint(root)
    expect(result.status).toBe(0)
  })

  it("allows text owned by Lingui components, including nested markup", () => {
    const root = fixture({
      "src/Component.tsx": [
        "export function C() {",
        "  return (",
        "    <p>",
        '      <Trans id="greeting">Hello <strong>there</strong></Trans>',
        "    </p>",
        "  )",
        "}",
        "",
      ].join("\n"),
    })
    const result = lint(root)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("no literal UI strings")
  })

  it("still flags a literal next to a Lingui component", () => {
    const root = fixture({
      "src/Component.tsx": [
        "export function C() {",
        "  return (",
        "    <div>",
        '      <Trans id="greeting">Hello there</Trans>',
        "      <p>Still hard-coded</p>",
        "    </div>",
        "  )",
        "}",
        "",
      ].join("\n"),
    })
    const result = lint(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Still hard-coded")
    expect(result.stderr).not.toContain("Hello there")
  })
})
