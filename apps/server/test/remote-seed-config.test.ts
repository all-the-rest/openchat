import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

/** The seeded OpenCode config: MCP entries and the compaction policy. */
const ROOT = resolve(import.meta.dirname, "..", "..", "..")
const SEED = join(ROOT, "deploy", "remote", "seed-config.sh")

const created: string[] = []
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

function bash(args: string[], input = "", env: Record<string, string> = {}) {
  return spawnSync("bash", args, {
    encoding: "utf8",
    input,
    env: { ...process.env, ...env },
  })
}

describe("OpenCode MCP config", { timeout: 60_000 }, () => {
  it("pins the compaction policy in a dry run", () => {
    const stack = temp("openchat-seed-dry-")
    writeFileSync(
      join(stack, ".env"),
      "ARTIFACT_INTERNAL_TOKEN=0123456789abcdef0123456789abcdef\nDOCUMENTS_TOKEN=fedcba9876543210fedcba9876543210\nMEMORY_INTERNAL_TOKEN=aaaabbbbccccddddeeeeffff00001111\n",
    )
    const result = bash([SEED, "--stack-dir", stack, "--dry-run"])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(
      "would: configure compaction auto=true buffer=35% keep.tokens=12000",
    )
    expect(existsSync(join(stack, "opencode-config", "opencode.json"))).toBe(false)
  })

  it("seeds the three local entries once, without printing any token", () => {
    const stack = temp("openchat-seed-")
    const token = "0123456789abcdef0123456789abcdef"
    const documentsToken = "fedcba9876543210fedcba9876543210"
    const memoryToken = "aaaabbbbccccddddeeeeffff00001111"
    writeFileSync(join(stack, ".env"), `ARTIFACT_INTERNAL_TOKEN=${token}\nDOCUMENTS_TOKEN=${documentsToken}\nMEMORY_INTERNAL_TOKEN=${memoryToken}\n`)

    const result = bash([SEED, "--stack-dir", stack])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).not.toContain(token)
    expect(result.stdout).not.toContain(memoryToken)
    expect(result.stdout).not.toContain(documentsToken)

    const file = join(stack, "opencode-config", "opencode.json")
    const text = readFileSync(file, "utf8")
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(text).toContain('"type": "local"')
    expect(text).toContain("/opt/artifact-tool/node_modules/.bin/tsx")
    expect(text).toContain("/opt/artifact-tool/packages/artifact-tool/src/index.ts")
    expect(text).toContain('"OPENCHAT_BFF_URL": "http://bff:8787"')
    expect(text).toContain(token)

    expect(text).toContain('"openchat-python"')
    expect(text).toContain("/opt/artifact-tool/packages/python-tool/src/index.ts")
    expect(text).toContain('"OPENCHAT_PYTHON": "/usr/bin/python3"')
    expect(text).toContain('"DOCUMENTS_URL": "http://documents:8099"')
    expect(text).toContain(documentsToken)

    expect(text).toContain('"openchat-memory"')
    expect(text).toContain("/opt/artifact-tool/packages/memory-tool/src/index.ts")
    expect(text).toContain('"MEMORY_INTERNAL_TOKEN": "' + memoryToken + '"')
    // The memory tool is a thin client: it reaches the store through the BFF.
    expect(text).toContain('"OPENCHAT_BFF_URL": "http://bff:8787"')

    const config = JSON.parse(text) as {
      mcp?: Record<string, { type?: string; command?: string[]; environment?: Record<string, string> }>
      compaction?: { auto?: boolean; buffer?: string; keep?: { tokens?: number } }
      agents?: { compaction?: { model?: string } }
    }
    expect(Object.keys(config.mcp ?? {}).sort()).toEqual([
      "openchat",
      "openchat-memory",
      "openchat-python",
    ])
    expect(config.mcp?.["openchat-memory"]?.type).toBe("local")
    expect(config.mcp?.["openchat-memory"]?.command).toEqual([
      "/opt/artifact-tool/node_modules/.bin/tsx",
      "/opt/artifact-tool/packages/memory-tool/src/index.ts",
    ])
    expect(config.mcp?.["openchat-memory"]?.environment).toEqual({
      OPENCHAT_BFF_URL: "http://bff:8787",
      MEMORY_INTERNAL_TOKEN: memoryToken,
    })
    expect(config.compaction).toEqual({
      auto: true,
      buffer: "35%",
      keep: { tokens: 12000 },
    })
    // No compaction model is invented; the host keeps its configured one.
    expect(config.agents?.compaction?.model).toBeUndefined()

    writeFileSync(file, `${text}\n`)
    const stamp = statSync(file).mtimeMs
    expect(bash([SEED, "--stack-dir", stack]).status).toBe(0)
    expect(readFileSync(file, "utf8")).toBe(`${text}\n`)
    expect(statSync(file).mtimeMs).toBe(stamp)
  })

  it("repairs a pre-existing world-readable config without touching its bytes", () => {
    const stack = temp("openchat-seed-mode-")
    // A token rotation only replaces a memory block whose values differ from
    // `.env`; this fixture is current, so the mode repair must keep the bytes.
    writeFileSync(
      join(stack, ".env"),
      "MEMORY_INTERNAL_TOKEN=aaaabbbbccccddddeeeeffff00001111\n",
    )
    const dir = join(stack, "opencode-config")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, "opencode.json")
    const body =
      '{"mcp":{"openchat":{"type":"local"},"openchat-memory":{"type":"local","environment":{"OPENCHAT_BFF_URL":"http://bff:8787","MEMORY_INTERNAL_TOKEN":"aaaabbbbccccddddeeeeffff00001111"}}}}\n'
    writeFileSync(file, body)
    chmodSync(file, 0o644)
    expect(statSync(file).mode & 0o777).toBe(0o644)

    const result = bash([SEED, "--stack-dir", stack])
    expect(result.status, result.stderr).toBe(0)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, "utf8")).toBe(body)
    expect(result.stdout).toContain("repaired mode")
  })
})

