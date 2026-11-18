import { createDocumentsClient } from "./documents-client"
import { loadDocumentsEnv } from "./env"
import { serveStdio } from "./mcp"
import { DOCUMENT_TOOLS, artifactSink, callDocumentTool } from "./tools"

/**
 * Entry point for the MCP client. Reads its configuration once, then answers
 * JSON-RPC on stdin/stdout until the client closes the pipe.
 */

export async function main(): Promise<void> {
  const env = loadDocumentsEnv()
  const sink = artifactSink({ bffUrl: env.bffUrl, token: env.token })
  const documents = createDocumentsClient({ url: env.documentsUrl, token: env.documentsToken })
  await serveStdio({
    input: process.stdin,
    output: process.stdout,
    tools: DOCUMENT_TOOLS,
    call: async (name, args) => {
      const result = await callDocumentTool(name, args, {
        python: env.python,
        sink,
        workspaceDir: env.workspaceDir,
        documents,
      })
      if (!result.ok) {
        return {
          text: `Document tool failed. Fix exactly this and retry at most twice: ${result.error}`,
          isError: true,
        }
      }
      return { text: result.text, isError: false }
    },
  })
}

await main()
