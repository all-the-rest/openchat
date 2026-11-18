import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/**
 * Contract test for the pinned Python set: every dependency is an exact
 * `name==version` line, no duplicates, no pre-releases, no VCS or URL
 * references, and every top-level name from requirements.in is resolved in
 * requirements.lock. No network and no interpreter needed.
 */

const LOCK = readFileSync(new URL("../../python-env/requirements.lock", import.meta.url), "utf8")
const INPUT = readFileSync(new URL("../../python-env/requirements.in", import.meta.url), "utf8")

const REQUIRED = ["python-docx", "openpyxl", "pypdf", "reportlab", "pillow"]
const PIN = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([0-9][A-Za-z0-9.+-]*)$/

function entries(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
}

function names(text: string): string[] {
  return entries(text).map((line) => line.split("==")[0] ?? line)
}

describe("requirements.lock", () => {
  it("pins every line with == and a version", () => {
    for (const line of entries(LOCK)) {
      expect(line, `unpinned line: ${line}`).toMatch(PIN)
    }
  })

  it("has no duplicate package", () => {
    const seen = new Set<string>()
    for (const name of names(LOCK)) {
      expect(seen.has(name.toLowerCase()), `duplicate: ${name}`).toBe(false)
      seen.add(name.toLowerCase())
    }
  })

  it("contains the five top-level libraries", () => {
    const pinned = names(LOCK).map((name) => name.toLowerCase())
    for (const name of REQUIRED) expect(pinned).toContain(name)
  })

  it("carries no pre-release, VCS, URL or editable reference", () => {
    for (const line of entries(LOCK)) {
      expect(line).not.toContain("--pre")
      expect(line).not.toContain("git+")
      expect(line).not.toContain("http")
      expect(line).not.toContain("-e ")
    }
  })

  it("ships no markitdown, by the documented size decision", () => {
    expect(names(LOCK).map((name) => name.toLowerCase())).not.toContain("markitdown")
  })
})

describe("requirements.in", () => {
  it("names only pinned top-level libraries", () => {
    for (const line of entries(INPUT)) expect(line).toMatch(PIN)
    expect(names(INPUT).map((name) => name.toLowerCase())).toEqual(REQUIRED)
  })

  it("is fully represented in the lock", () => {
    const locked = names(LOCK).map((name) => name.toLowerCase())
    for (const name of names(INPUT)) expect(locked).toContain(name.toLowerCase())
  })
})
