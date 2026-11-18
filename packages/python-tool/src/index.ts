import { createDocumentsClient } from "./documents-client"
import { loadDocumentsToolEnv } from "./env"
import { serveStdio } from "./mcp"
import type { ToolCallResult } from "./mcp"
import { createRunner } from "./runner"
import { runDocumentTool } from "./tool"
import type { ToolDeps, ToolSuccess } from "./tool"

/**
 * Entry point for the MCP client. Configuration is read once, then the server
 * answers JSON-RPC on stdin/stdout until the pipe closes. The only I/O is the
 * BFF's internal artifact routes; the Python child gets a temporary directory
 * and a minimal environment, never this process's token.
 */

function formatSuccess(value: ToolSuccess, read: boolean): string {
  const verb = read ? "Read" : "Wrote"
  const head = `${verb} "${value.filename}" (artifact ${value.artifactID}, ${value.fileBytes} bytes).`
  const files = value.files === undefined ? "" : `\nChat files: ${value.files.join(", ")}.`
  const preview = value.preview === undefined ? "" : `\n\n${value.preview}`
  return `${head}${files}${preview}`
}

function call(deps: ToolDeps) {
  return async (name: string, args: unknown): Promise<ToolCallResult> => {
    const result = await runDocumentTool(name, args, deps)
    if (!result.ok) {
      return {
        text: `Document not written. Fix exactly this and retry at most twice: ${result.error}`,
        isError: true,
      }
    }
    return { text: formatSuccess(result.value, name === "read_document"), isError: false }
  }
}

export async function main(): Promise<void> {
  const env = loadDocumentsToolEnv()
  const runner = createRunner({ python: env.python })
  const documents = createDocumentsClient({ url: env.documentsUrl, token: env.documentsToken })
  await serveStdio({
    input: process.stdin,
    output: process.stdout,
    call: call({
      bffUrl: env.bffUrl,
      token: env.token,
      runner,
      workspaceDir: env.workspaceDir,
      documents,
    }),
  })
}

await main()
