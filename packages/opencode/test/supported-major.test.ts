import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  matchesSupportedMajor,
  OPENCODE_CLIENT_RANGE,
  SUPPORTED_OPENCODE_MAJOR,
  SUPPORTED_OPENCODE_MAJOR_LABEL,
} from "../src/index"

const PACKAGE_ROOT = join(import.meta.dirname, "..")

interface Manifest {
  version?: string
  dependencies?: Record<string, string>
}

function manifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest
}

const CARET_RANGE = /^\^(\d+)\.(\d+)\.(\d+)$/
const VERSION = /^(\d+)\.(\d+)\.(\d+)/

/** Caret semantics for a plain `^major.minor.patch` range. */
function satisfiesRange(version: string, range: string): boolean {
  const bound = CARET_RANGE.exec(range)
  const actual = VERSION.exec(version)
  if (!bound || !actual) return false
  const boundMajor = Number(bound[1])
  const boundMinor = Number(bound[2])
  const boundPatch = Number(bound[3])
  const major = Number(actual[1])
  const minor = Number(actual[2])
  const patch = Number(actual[3])
  if (major !== boundMajor) return false
  if (minor > boundMinor) return true
  if (minor < boundMinor) return false
  return patch >= boundPatch
}

describe("supported @opencode/client major", () => {
  it("declares the range in the package manifest", () => {
    const pkg = manifest(join(PACKAGE_ROOT, "package.json"))
    expect(pkg.dependencies?.["@opencode/client"]).toBe(OPENCODE_CLIENT_RANGE)
  })

  it("derives the supported major from the range", () => {
    expect(OPENCODE_CLIENT_RANGE).toMatch(CARET_RANGE)
    expect(SUPPORTED_OPENCODE_MAJOR).toBe(2)
    expect(SUPPORTED_OPENCODE_MAJOR).toBe(Number(CARET_RANGE.exec(OPENCODE_CLIENT_RANGE)?.[1]))
    expect(SUPPORTED_OPENCODE_MAJOR_LABEL).toBe("2")
  })

  it("accepts the installed version as satisfying the declared range", () => {
    const installed = manifest(
      join(PACKAGE_ROOT, "node_modules", "@opencode", "client", "package.json"),
    )
    expect(installed.version).toBeDefined()
    expect(satisfiesRange(installed.version ?? "", OPENCODE_CLIENT_RANGE)).toBe(true)
    expect(matchesSupportedMajor(installed.version ?? "")).toBe(true)
  })

  it("accepts a host on the same major", () => {
    expect(matchesSupportedMajor("2.3.0")).toBe(true)
  })

  it("accepts a minor or patch skew", () => {
    expect(matchesSupportedMajor("2.4.0")).toBe(true)
    expect(matchesSupportedMajor("2.3.7")).toBe(true)
    expect(matchesSupportedMajor("2.10.0")).toBe(true)
  })

  it("rejects a host on another major", () => {
    expect(matchesSupportedMajor("3.0.0")).toBe(false)
    expect(matchesSupportedMajor("1.9.0")).toBe(false)
  })

  it("rejects a malformed version", () => {
    expect(matchesSupportedMajor("")).toBe(false)
    expect(matchesSupportedMajor("dev")).toBe(false)
  })
})
