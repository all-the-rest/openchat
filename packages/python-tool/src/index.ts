import { createArchiveRunner } from "./runner-archive"
import { createDocumentsClient } from "./documents-client"
import { loadDocumentsToolEnv } from "./env"
import { formatArchive, formatToolSuccess } from "./format"
import { serveStdio } from "./mcp"
import type { ToolCallResult } from "./mcp"
import { createRunner } from "./runner"
import { runDocumentTool } from "./tool"
import type { ToolDeps } from "./tool"

/**
 * Entry point for the MCP client. Configuration is read once, then the server
 * answers JSON-RPC on stdin/stdout until the pipe closes. The only I/O is the
 * BFF's internal artifact routes and the chat files directory; the Python
 * child gets a temporary directory and a minimal environment, never this
 * process's token.
 */

function call(deps: ToolDeps) {
  return async (name: string, args: unknown): Promise<ToolCallResult> => {
    const archive = name === "archive_list" || name === "archive_extract"
    const result = await runDocumentTool(name, args, deps)
    if (!result.ok) {
      return {
        text: `${
          archive ? "Archive not changed" : "Document not written"
        }. Fix exactly this and retry at most twice: ${result.error}`,
        isError: true,
      }
    }
    const text =
      "kind" in result.value
        ? formatArchive(result.value)
        : formatToolSuccess(result.value, name === "read_document")
    return { text, isError: false }
  }
}

export async function main(): Promise<void> {
  const env = loadDocumentsToolEnv()
  const runner = createRunner({ python: env.python })
  const archiveRunner = createArchiveRunner({ python: env.python })
  const documents = createDocumentsClient({ url: env.documentsUrl, token: env.documentsToken })
  await serveStdio({
    input: process.stdin,
    output: process.stdout,
    call: call({
      bffUrl: env.bffUrl,
      token: env.token,
      runner,
      archiveRunner,
      workspaceDir: env.workspaceDir,
      documents,
    }),
  })
}

await main()
