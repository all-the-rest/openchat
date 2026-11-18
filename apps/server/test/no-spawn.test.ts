import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = resolve(import.meta.dirname, "..", "..", "..")
const SOURCE_DIRS = ["apps/server/src", "packages/opencode/src"].map((dir) => join(ROOT, dir))

/**
 * The BFF must attach to the OpenCode service that already runs at
 * `OPENCODE_URL`. Spawning a second one reads the same database but has its own
 * process-bound state, so a TUI turn would never appear in the web stream.
 */
const FORBIDDEN = ["child_process", "spawn(", "execFile(", "execa", "opencode serve"]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .filter((name): name is string => typeof name === "string" && name.endsWith(".ts"))
    .map((name) => join(dir, name))
}

describe("shared OpenCode service", () => {
  it("never starts an OpenCode process from the BFF", () => {
    const offenders: string[] = []
    for (const file of SOURCE_DIRS.flatMap(sourceFiles)) {
      const text = readFileSync(file, "utf8")
      const hit = FORBIDDEN.find((needle) => text.includes(needle))
      if (hit) offenders.push(`${relative(ROOT, file)} contains ${JSON.stringify(hit)}`)
    }

    expect(
      offenders,
      `The BFF must attach to OPENCODE_URL, never spawn its own OpenCode:\n${offenders.join("\n")}`,
    ).toEqual([])
  })
})
