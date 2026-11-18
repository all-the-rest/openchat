import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * The locks are a contract, not a note. The image installs both with
 * `--no-index`/`--no-deps`, so a range, a duplicate or a stray directive would
 * either change the bytes between builds or fail the offline install. The
 * native half has two representations (apk in the image, PyPI on a
 * workstation); they must describe the same versions.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..")
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8")

const LOCK = read("packages", "python-env", "requirements.lock")
const DEV_LOCK = read("packages", "python-env", "requirements-dev.lock")
const INPUT = read("packages", "python-env", "requirements.in")
const APK = read("packages", "python-env", "apk-packages.txt")

function requirements(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
}

const LOCKED = requirements(LOCK)
const DEV_LOCKED = requirements(DEV_LOCK)
const APK_PACKAGES = requirements(APK)
const ALL = [...LOCKED, ...DEV_LOCKED]

function nameOf(line: string): string {
  return line.split("==")[0]?.toLowerCase() ?? ""
}

function versionOf(line: string): string {
  return line.split("==")[1] ?? ""
}

/** `markitdown[docx,pdf]==0.1.9` → `markitdown==0.1.9`. */
function withoutExtras(line: string): string {
  return line.replace(/\[[^\]]*\]/, "")
}

/** apk pins are `name=version-rN`; the distribution version drops `-rN`. */
const APK_TO_DIST: Record<string, string> = {
  "py3-onnxruntime": "onnxruntime",
  "py3-pandas": "pandas",
  "py3-lxml": "lxml",
  "py3-openpyxl": "openpyxl",
  "py3-cryptography": "cryptography",
  "py3-pillow": "pillow",
}

describe("requirements.lock", () => {
  it("pins every distribution with ==", () => {
    expect(LOCKED.length).toBeGreaterThanOrEqual(20)
    for (const line of LOCKED) {
      expect(line, `${line} must be an exact pin`).toMatch(
        /^[A-Za-z0-9][A-Za-z0-9._-]*==[0-9]+(?:\.[0-9]+)*$/,
      )
    }
  })

  it("has no duplicate distribution", () => {
    const names = LOCKED.map(nameOf)
    expect(new Set(names).size).toBe(names.length)
  })

  it("carries no pre-release, extras, URLs or directives", () => {
    for (const line of LOCKED) {
      expect(line).not.toMatch(/--pre|@|:\/\/|;|\[/)
    }
  })

  it("keeps the native half out of the pip install", () => {
    const names = LOCKED.map(nameOf)
    for (const native of ["onnxruntime", "numpy", "pandas", "lxml", "openpyxl", "cryptography", "pillow"]) {
      expect(names, `${native} must come from apk in the image`).not.toContain(native)
    }
    expect(LOCK).not.toMatch(/\bpandoc\b/i)
  })

  it("does not install the pypdfium2 renderer nobody imports", () => {
    const names = LOCKED.map(nameOf)
    expect(names).not.toContain("pypdfium2")
    expect(names).not.toContain("pypdf")
  })

  it("contains markitdown and the converter halves of the four extras", () => {
    const names = LOCKED.map(nameOf)
    for (const dependency of [
      "markitdown",
      "magika",
      "mammoth",
      "pdfminer.six",
      "pdfplumber",
      "python-docx",
      "python-pptx",
      "reportlab",
    ]) {
      expect(names, `${dependency} missing from the lock`).toContain(dependency)
    }
  })
})

describe("requirements-test.lock", () => {
  it("pins the test-only reader exactly and keeps it out of the image", () => {
    const test = requirements(read("packages", "python-env", "requirements-test.lock"))
    expect(test.length).toBeGreaterThanOrEqual(1)
    for (const line of test) {
      expect(line, `${line} must be an exact pin`).toMatch(
        /^[A-Za-z0-9][A-Za-z0-9._-]*==[0-9]+(?:\.[0-9]+)*$/,
      )
      expect(LOCKED.map(nameOf), `${line} must not ship in the image`).not.toContain(nameOf(line))
    }
    expect(test.map(nameOf)).toContain("pypdf")
  })
})

describe("requirements-dev.lock", () => {
  it("pins every distribution with ==", () => {
    expect(DEV_LOCKED.length).toBeGreaterThanOrEqual(15)
    for (const line of DEV_LOCKED) {
      expect(line, `${line} must be an exact pin`).toMatch(
        /^[A-Za-z0-9][A-Za-z0-9._-]*==[0-9]+(?:\.[0-9]+)*$/,
      )
    }
  })

  it("has no duplicate distribution and no overlap with the pip lock", () => {
    const names = DEV_LOCKED.map(nameOf)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) {
      expect(LOCKED.map(nameOf), `${name} is pinned twice`).not.toContain(name)
    }
  })
})

describe("requirements.in", () => {
  it("is covered by the two locks at the exact version", () => {
    for (const line of requirements(INPUT)) {
      const pinned = withoutExtras(line)
      expect(ALL, `${pinned} missing from both locks`).toContain(pinned)
    }
  })

  it("requests markitdown's four format extras, never `all`", () => {
    const markitdown = requirements(INPUT).find((line) => line.startsWith("markitdown"))
    expect(markitdown).toBe("markitdown[docx,xlsx,pptx,pdf]==0.1.9")
    expect(INPUT).not.toMatch(/markitdown\[all\]/)
  })
})

describe("apk-packages.txt", () => {
  it("pins every package to an exact Alpine version", () => {
    expect(APK_PACKAGES.length).toBeGreaterThanOrEqual(6)
    for (const line of APK_PACKAGES) {
      expect(line, `${line} must be an apk pin`).toMatch(
        /^py3-[a-z0-9-]+=[0-9]+\.[0-9]+(?:\.[0-9]+)?-r[0-9]+$/,
      )
    }
  })

  it("describes the same versions as the development lock", () => {
    const dev = new Map(DEV_LOCKED.map((line) => [nameOf(line), versionOf(line)]))
    for (const line of APK_PACKAGES) {
      const [apkName, apkVersion] = line.split("=")
      const dist = APK_TO_DIST[apkName ?? ""]
      expect(dist, `unmapped apk package ${apkName}`).toBeDefined()
      expect(dev.get(dist ?? ""), `${dist} differs between apk and the dev lock`).toBe(
        apkVersion?.replace(/-r[0-9]+$/, ""),
      )
    }
  })
})
