import type { FetchLike } from "@openchat/artifact-tool/bff"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { MAX_FILE_BYTES } from "../src/limits"
import type { PythonFile, PythonRunner } from "../src/runner"
import { runDocumentTool } from "../src/tool"

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const RECEIPT = { artifactID: "c".repeat(64), title: "Report", bytes: 900 }
const PATH = "session-1/files/report.docx"

const created: string[] = []
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workspace(): { root: string; files: string } {
  const root = mkdtempSync(join(tmpdir(), "python-tool-from-text-"))
  created.push(root)
  const files = join(root, "chats", "session-1", "files")
  mkdirSync(files, { recursive: true, mode: 0o700 })
  return { root, files }
}

interface Spy {
  runner: PythonRunner
  runs: Array<{ tool: string; input: Record<string, unknown> }>
  posts: Array<{ title: string; html: string }>
}

function spy(file: PythonFile = { filename: "report.docx", mediaType: DOCX, data: Buffer.from("docx") }): Spy {
  const runs: Array<{ tool: string; input: Record<string, unknown> }> = []
  const posts: Array<{ title: string; html: string }> = []
  const runner: PythonRunner = async (tool, input) => {
    runs.push({ tool, input })
    return { ok: true, value: file }
  }
  return { runner, runs, posts }
}

function fetcher(posts: Array<{ title: string; html: string }>, status = 201): FetchLike {
  return async (_url, init) => {
    if (init.method === "POST") {
      posts.push(JSON.parse(String(init.body)) as { title: string; html: string })
      return new Response(JSON.stringify(RECEIPT), { status })
    }
    return new Response("", { status: 404 })
  }
}

function deps(root: string | undefined, s: Spy) {
  return {
    bffUrl: "http://bff.example:8787",
    token: "test-internal-token-0123456789abcdef",
    fetch: fetcher(s.posts),
    runner: s.runner,
    ...(root === undefined ? {} : { workspaceDir: root }),
  }
}

const BLOCKS = [
  { kind: "heading", level: 1, text: "Report" },
  { kind: "paragraph", text: "Hello" },
]

describe("docx_from_text tool", () => {
  it("writes the chat file, stores the card and reports both", async () => {
    const { root, files } = workspace()
    const s = spy()
    const result = await runDocumentTool(
      "docx_from_text",
      { title: "Report", chatPath: PATH, blocks: BLOCKS },
      deps(root, s),
    )

    expect(result).toMatchObject({
      ok: true,
      value: { artifactID: RECEIPT.artifactID, filename: "report.docx", files: ["report.docx"] },
    })
    expect(s.runs).toEqual([
      { tool: "docx_from_text", input: { filename: "report.docx", title: "Report", blocks: BLOCKS } },
    ])
    expect(s.posts).toHaveLength(1)
    expect(readFileSync(join(files, "report.docx")).toString()).toBe("docx")
    expect(statSync(join(files, "report.docx")).mode & 0o777).toBe(0o600)
  })

  it("derives the artifact title and omits the document heading when none was asked for", async () => {
    const { root } = workspace()
    const s = spy()
    const result = await runDocumentTool(
      "docx_from_text",
      { chatPath: PATH, markdown: "# Report\n\nHello" },
      deps(root, s),
    )

    expect(result.ok).toBe(true)
    expect(s.runs[0]?.input).not.toHaveProperty("title")
    expect(s.posts[0]?.title).toBe("Report")
  })

  it("stops before Python and the network on a validation error", async () => {
    const { root } = workspace()
    const s = spy()
    const result = await runDocumentTool(
      "docx_from_text",
      { chatPath: "/etc/report.docx", blocks: BLOCKS },
      deps(root, s),
    )

    expect(result).toEqual({ ok: false, error: "chatPath: use <sessionID>/files/<name>.docx" })
    expect(s.runs).toHaveLength(0)
    expect(s.posts).toHaveLength(0)
  })

  it("refuses to run without a workspace directory", async () => {
    const s = spy()
    const result = await runDocumentTool(
      "docx_from_text",
      { chatPath: PATH, blocks: BLOCKS },
      deps(undefined, s),
    )
    expect(result).toEqual({ ok: false, error: "chatPath: WORKSPACE_DIR is not configured" })
    expect(s.runs).toHaveLength(0)
  })

  it("keeps an existing file and cards the suffixed name", async () => {
    const { root, files } = workspace()
    writeFileSync(join(files, "report.docx"), "existing")
    const s = spy()
    const result = await runDocumentTool(
      "docx_from_text",
      { title: "Report", chatPath: PATH, blocks: BLOCKS },
      deps(root, s),
    )

    expect(result).toMatchObject({ ok: true, value: { filename: "report-1.docx", files: ["report-1.docx"] } })
    expect(readFileSync(join(files, "report.docx")).toString()).toBe("existing")
    expect(readFileSync(join(files, "report-1.docx")).toString()).toBe("docx")
  })

  it("refuses a chat folder that does not exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "python-tool-from-text-"))
    created.push(root)
    const s = spy()
    const result = await runDocumentTool(
      "docx_from_text",
      { chatPath: PATH, blocks: BLOCKS },
      deps(root, s),
    )
    expect(result).toEqual({ ok: false, error: "chatPath: the chat directory is not a safe directory" })
    expect(s.posts).toHaveLength(0)
  })

  it("rejects an oversized file before it is written or stored", async () => {
    const { root, files } = workspace()
    const s = spy({ filename: "report.docx", mediaType: DOCX, data: Buffer.alloc(MAX_FILE_BYTES + 1) })
    const result = await runDocumentTool(
      "docx_from_text",
      { chatPath: PATH, blocks: BLOCKS },
      deps(root, s),
    )
    expect(result).toEqual({
      ok: false,
      error: "size: the generated document exceeds the artifact limit",
    })
    expect(s.posts).toHaveLength(0)
    expect(() => statSync(join(files, "report.docx"))).toThrow()
  })

  it("maps a storage failure without a traceback", async () => {
    const { root } = workspace()
    const s = spy()
    const result = await runDocumentTool(
      "docx_from_text",
      { chatPath: PATH, blocks: BLOCKS },
      {
        bffUrl: "http://bff.example:8787",
        token: "test-internal-token-0123456789abcdef",
        fetch: fetcher(s.posts, 503),
        runner: s.runner,
        workspaceDir: root,
      },
    )
    expect(result).toEqual({ ok: false, error: "unavailable: the BFF has no artifact storage configured" })
  })
})
