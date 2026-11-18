import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { ProcessInvocation, ProcessOutcome, ProcessRunner } from "../src/process"
import { DEFAULT_MEMORY_MB, MAX_OUTPUT_BYTES, createTempDir, runPython } from "../src/runner"

const SCRIPTS = ["docx_fill", "xlsx_write", "pdf_from_markdown", "read_document"]
const created: string[] = []

let scriptDir: URL

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "python-tool-scripts-"))
  created.push(dir)
  for (const name of SCRIPTS) writeFileSync(join(dir, `${name}.py`), "# fixture\n")
  scriptDir = pathToFileURL(`${dir}/`)
})

afterAll(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "python-tool-root-"))
  created.push(dir)
  return dir
}

function outcome(overrides: Partial<ProcessOutcome> = {}): ProcessOutcome {
  return {
    status: 0,
    stdout: '{"ok":true}\n',
    stderr: "",
    timedOut: false,
    spawnFailed: false,
    stdoutOverflow: false,
    ...overrides,
  }
}

interface Fake {
  runner: ProcessRunner
  calls: ProcessInvocation[]
}

function fake(
  respond: (invocation: ProcessInvocation) => Partial<ProcessOutcome> | Promise<Partial<ProcessOutcome>> = () => ({}),
): Fake {
  const calls: ProcessInvocation[] = []
  const runner: ProcessRunner = async (invocation) => {
    calls.push(invocation)
    return outcome(await respond(invocation))
  }
  return { runner, calls }
}

function run(
  runner: ProcessRunner,
  request: Parameters<typeof runPython>[0],
  extra: { timeoutMs?: number } = {},
) {
  return runPython(request, {
    python: "python3",
    scriptDir,
    runProcess: runner,
    tempRoot: tempRoot(),
    ...extra,
  })
}

describe("subprocess guard", () => {
  it("runs one fixed script with a JSON payload and reads the declared file", async () => {
    const { runner, calls } = fake((invocation) => {
      writeFileSync(join(invocation.cwd, "output.docx"), Buffer.from("PK\u0003\u0004docx"))
      return { stdout: '{"ok":true,"file":"output.docx"}\n' }
    })
    const result = await run(runner, {
      script: "docx_fill",
      payload: { title: "Report" },
      files: { "template.docx": new Uint8Array([0x50, 0x4b]) },
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.file?.name).toBe("output.docx")
      expect(Buffer.from(result.value.file?.bytes ?? []).toString("utf8")).toContain("docx")
    }

    const call = calls[0]
    if (!call) throw new Error("no process was started")
    expect(call.command).toBe("python3")
    expect(call.args[0]).toBe("-I")
    expect(call.args[1]).toBe("-B")
    expect(call.args[2]?.endsWith("docx_fill.py")).toBe(true)
    expect(call.args[3]).toBe(String(DEFAULT_MEMORY_MB))
    expect(call.env).toEqual({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: call.cwd,
      TMPDIR: call.cwd,
      PYTHONHASHSEED: "0",
      PYTHONDONTWRITEBYTECODE: "1",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    })
    expect(JSON.parse(call.input)).toEqual({
      title: "Report",
      output: "output.docx",
      input: "template.docx",
    })
  })

  it("removes the temp dir after a success and after a failure", async () => {
    const success = fake((invocation) => {
      writeFileSync(join(invocation.cwd, "output.xlsx"), "xlsx")
      return { stdout: '{"ok":true,"file":"output.xlsx"}' }
    })
    await run(success.runner, { script: "xlsx_write", payload: {} })
    expect(existsSync(success.calls[0]?.cwd ?? "")).toBe(false)

    const failure = fake(() => ({ status: 1, stdout: "" }))
    await run(failure.runner, { script: "xlsx_write", payload: {} })
    expect(existsSync(failure.calls[0]?.cwd ?? "")).toBe(false)
  })

  it("removes the temp dir after a timeout", async () => {
    const timeout = fake(() => ({ timedOut: true, status: null }))
    const result = await run(timeout.runner, { script: "pdf_from_markdown", payload: {} })
    expect(result).toMatchObject({ ok: false, code: "timeout" })
    expect(existsSync(timeout.calls[0]?.cwd ?? "")).toBe(false)
  })

  it("does not leak a stray file on failure either", async () => {
    const failure = fake((invocation) => {
      writeFileSync(join(invocation.cwd, "output.docx"), "partial")
      return { status: 2, stderr: "Traceback (most recent call last):\n  File x\nValueError" }
    })
    const result = await run(failure.runner, { script: "docx_fill", payload: {} })
    expect(result).toMatchObject({ ok: false, code: "crashed" })
    if (!result.ok) {
      expect(result.message).not.toContain("Traceback")
      expect(result.message).not.toContain("ValueError")
    }
  })

  it.each([
    ["a spawn failure", { spawnFailed: true }, "python_missing"],
    ["a nonzero exit", { status: 1 }, "crashed"],
    ["malformed stdout", { stdout: "not json\n" }, "invalid_output"],
    ["empty stdout", { stdout: "" }, "invalid_output"],
    ["stdout above the cap", { stdoutOverflow: true }, "invalid_output"],
  ])("maps %s to a fixed code", async (_label, overrides, code) => {
    const result = await run(fake(() => overrides).runner, {
      script: "docx_fill",
      payload: {},
    })
    expect(result).toMatchObject({ ok: false, code })
  })

  it("classifies a MemoryError traceback as a memory failure", async () => {
    const result = await run(
      fake(() => ({ status: 1, stderr: "Traceback...\nMemoryError" })).runner,
      { script: "docx_fill", payload: {} },
    )
    expect(result).toMatchObject({ ok: false, code: "memory" })
  })

  it("maps a script-reported code and falls back for an unknown one", async () => {
    const macro = await run(
      fake(() => ({ stdout: '{"ok":false,"code":"macro_document"}' })).runner,
      { script: "docx_fill", payload: {} },
    )
    expect(macro).toMatchObject({ ok: false, code: "macro_document" })
    if (!macro.ok) expect(macro.message).toContain(".docm")

    const unknown = await run(
      fake(() => ({ stdout: '{"ok":false,"code":"ZeroDivisionError"}' })).runner,
      { script: "docx_fill", payload: {} },
    )
    expect(unknown).toMatchObject({ ok: false, code: "crashed" })
  })

  it("returns text for read_document and no file", async () => {
    const result = await run(
      fake(() => ({ stdout: '{"ok":true,"text":"# Heading\\n\\nbody"}' })).runner,
      { script: "read_document", payload: { kind: "docx" }, files: { "input.docx": new Uint8Array([1]) } },
    )
    expect(result).toMatchObject({ ok: true, value: { text: "# Heading\n\nbody" } })
    if (result.ok) expect(result.value.file).toBeUndefined()
  })

  it("refuses a declared file outside the temp dir", async () => {
    const outside = mkdtempSync(join(tmpdir(), "python-tool-outside-"))
    created.push(outside)
    writeFileSync(join(outside, "secret"), "secret")
    const result = await run(
      fake(() => ({ stdout: '{"ok":true,"file":"../secret"}' })).runner,
      { script: "docx_fill", payload: {} },
    )
    expect(result).toMatchObject({ ok: false, code: "invalid_output" })
  })

  it("refuses a symlinked output", async () => {
    const outside = mkdtempSync(join(tmpdir(), "python-tool-link-"))
    created.push(outside)
    writeFileSync(join(outside, "target"), "target")
    const result = await run(
      fake((invocation) => {
        symlinkSync(join(outside, "target"), join(invocation.cwd, "output.docx"))
        return { stdout: '{"ok":true,"file":"output.docx"}' }
      }).runner,
      { script: "docx_fill", payload: {} },
    )
    expect(result).toMatchObject({ ok: false, code: "invalid_output" })
  })

  it("refuses an output above the byte cap", async () => {
    const result = await run(
      fake((invocation) => {
        writeFileSync(join(invocation.cwd, "output.docx"), Buffer.alloc(MAX_OUTPUT_BYTES + 1))
        return { stdout: '{"ok":true,"file":"output.docx"}' }
      }).runner,
      { script: "docx_fill", payload: {} },
    )
    expect(result).toMatchObject({ ok: false, code: "invalid_output" })
  })

  it("refuses a missing output file", async () => {
    const result = await run(fake().runner, { script: "docx_fill", payload: {} })
    expect(result).toMatchObject({ ok: false, code: "invalid_output" })
  })

  it("refuses unsafe input file names and more than one input", async () => {
    const unsafe = await run(fake().runner, {
      script: "docx_fill",
      payload: {},
      files: { "../escape.docx": new Uint8Array([1]) },
    })
    expect(unsafe).toMatchObject({ ok: false, code: "invalid_output" })

    const two = await run(fake().runner, {
      script: "docx_fill",
      payload: {},
      files: { "a.docx": new Uint8Array([1]), "b.docx": new Uint8Array([2]) },
    })
    expect(two).toMatchObject({ ok: false, code: "invalid_output" })
  })

  it("reports a missing script as an internal fault, not a Python failure", async () => {
    const missing = await runPython(
      { script: "docx_fill", payload: {} },
      {
        python: "python3",
        scriptDir: pathToFileURL(`${tempRoot()}/`),
        runProcess: fake().runner,
      },
    )
    expect(missing).toMatchObject({ ok: false, code: "invalid_output" })
  })
})

describe("temp dir", () => {
  it("removes idempotently", async () => {
    const dir = await createTempDir(tempRoot())
    expect(existsSync(dir.path)).toBe(true)
    await dir.remove()
    await dir.remove()
    expect(existsSync(dir.path)).toBe(false)
  })

  it("creates a directory below the injected root", async () => {
    const root = tempRoot()
    const dir = await createTempDir(root)
    expect(dir.path.startsWith(root)).toBe(true)
    mkdirSync(join(dir.path, "nested"), { recursive: true })
    await dir.remove()
    expect(existsSync(dir.path)).toBe(false)
  })
})
