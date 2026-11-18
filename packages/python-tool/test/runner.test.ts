import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ProcessResult, SpawnFn, SpawnOptions } from "../src/runner"
import { createRunner } from "../src/runner"

const roots: string[] = []

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "python-tool-runner-"))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true })
})

function success(filename = "report.pdf", mediaType = "application/pdf", body = "pdf"): ProcessResult {
  return {
    code: 0,
    stdout: JSON.stringify({
      ok: true,
      filename,
      mediaType,
      data: Buffer.from(body).toString("base64"),
    }),
    stderr: "",
    timedOut: false,
  }
}

function withSpawn(result: ProcessResult | (() => Promise<ProcessResult>)): {
  spawn: SpawnFn
  calls: SpawnOptions[]
} {
  const calls: SpawnOptions[] = []
  const spawn: SpawnFn = async (_command, _args, options) => {
    calls.push(options)
    return typeof result === "function" ? result() : result
  }
  return { spawn, calls }
}

describe("runner: success and isolation", () => {
  it("parses the structured file and removes the temporary directory", async () => {
    const tempRoot = await root()
    const { spawn, calls } = withSpawn(success())
    const run = createRunner({ spawn, tempRoot })
    const result = await run("pdf_from_markdown", { markdown: "# Hi" })

    expect(result).toMatchObject({
      ok: true,
      value: { filename: "report.pdf", mediaType: "application/pdf" },
    })
    if (!result.ok) throw new Error("expected success")
    expect(result.value.data.toString("utf8")).toBe("pdf")

    const call = calls[0]
    if (!call) throw new Error("spawn was not called")
    expect(call.input).toBe(JSON.stringify({ markdown: "# Hi" }))
    expect(call.env.ARTIFACT_INTERNAL_TOKEN).toBeUndefined()
    expect(call.env.HOME).toBe(call.cwd)
    expect(call.cwd.startsWith(tempRoot)).toBe(true)
    expect(await readdir(tempRoot)).toEqual([])
  })

  it("writes one JSON object and never a shell string", async () => {
    const tempRoot = await root()
    const { spawn, calls } = withSpawn(success())
    await createRunner({ spawn, tempRoot })("docx_fill", {
      paragraphs: ["a; echo pwned", "$(id)"],
    })
    const call = calls[0]
    if (!call) throw new Error("spawn was not called")
    expect(() => JSON.parse(call.input) as unknown).not.toThrow()
    expect(call.input).toContain("a; echo pwned")
  })
})

describe("runner: error mapping", () => {
  it("kills on timeout with a fixed message", async () => {
    const tempRoot = await root()
    const run = createRunner({
      spawn: withSpawn({ code: null, stdout: "", stderr: "", timedOut: true }).spawn,
      tempRoot,
    })
    expect(await run("pdf_from_markdown", {})).toEqual({
      ok: false,
      error: "timeout: the document tool did not finish in 30 s",
    })
    expect(await readdir(tempRoot)).toEqual([])
  })

  it("maps a structured nonzero exit to its fixed message", async () => {
    const tempRoot = await root()
    const run = createRunner({
      spawn: withSpawn({
        code: 1,
        stdout: '{"ok":false,"code":"parse_failed"}',
        stderr: "",
        timedOut: false,
      }).spawn,
      tempRoot,
    })
    expect(await run("read_document", {})).toEqual({
      ok: false,
      error: "parse: the document could not be read",
    })
  })

  it("never returns stderr or a traceback", async () => {
    const tempRoot = await root()
    const traceback = "Traceback (most recent call last):\n  File \"x.py\", line 1, in <module>\nSecret"
    const run = createRunner({
      spawn: withSpawn({ code: 1, stdout: "", stderr: traceback, timedOut: false }).spawn,
      tempRoot,
    })
    const result = await run("docx_fill", {})
    expect(result).toEqual({ ok: false, error: "internal: the document tool failed" })
    if (result.ok) throw new Error("expected failure")
    expect(result.error).not.toContain("Traceback")
    expect(result.error).not.toContain("Secret")
  })

  it("maps a malformed success body without echoing it", async () => {
    const tempRoot = await root()
    const run = createRunner({
      spawn: withSpawn({
        code: 0,
        stdout: "not json",
        stderr: "UPSTREAM-TEXT",
        timedOut: false,
      }).spawn,
      tempRoot,
    })
    const result = await run("xlsx_write", {})
    expect(result).toEqual({
      ok: false,
      error: "internal: the document tool answered an unexpected body",
    })
    if (result.ok) throw new Error("expected failure")
    expect(result.error).not.toContain("UPSTREAM-TEXT")
  })

  it("rejects a file outside the tool's extension or over the cap", async () => {
    const tempRoot = await root()
    const wrong = createRunner({
      spawn: withSpawn(success("report.pdf")).spawn,
      tempRoot,
    })
    expect(await wrong("docx_fill", {})).toEqual({
      ok: false,
      error: "internal: the document tool answered an unexpected body",
    })

    const big = createRunner({
      spawn: withSpawn(success("big.pdf", "application/pdf", "x".repeat(701 * 1024))).spawn,
      tempRoot,
    })
    expect(await big("pdf_from_markdown", {})).toEqual({
      ok: false,
      error: "size: the generated document exceeds the artifact limit",
    })
  })

  it("reports a missing interpreter and a spawn failure distinctly", async () => {
    const tempRoot = await root()
    const missing = createRunner({
      spawn: withSpawn({ code: null, stdout: "", stderr: "", timedOut: false, failure: "spawn" }).spawn,
      tempRoot,
    })
    expect(await missing("docx_fill", {})).toEqual({
      ok: false,
      error: "python: the document tool could not start; run pnpm run setup:python",
    })

    const thrown = createRunner({
      spawn: async () => {
        throw new Error("boom")
      },
      tempRoot,
    })
    expect(await thrown("docx_fill", {})).toEqual({
      ok: false,
      error: "internal: the document tool failed",
    })
    expect(await readdir(tempRoot)).toEqual([])
  })

  it("stops at the child-output cap", async () => {
    const tempRoot = await root()
    const run = createRunner({
      spawn: withSpawn({ code: null, stdout: "", stderr: "", timedOut: false, failure: "output" }).spawn,
      tempRoot,
    })
    expect(await run("xlsx_write", {})).toEqual({
      ok: false,
      error: "internal: the document tool produced too much output",
    })
  })
})
