import { loadToolEnv } from "./env"
import { serveStdio } from "./mcp"
import type { ToolCallResult } from "./mcp"
import { writeApp } from "./tool"
import type { ToolDeps } from "./tool"

/**
 * Entry point for the MCP client. Reads its configuration once, then answers
 * JSON-RPC on stdin/stdout until the client closes the pipe.
 */

function formatSuccess(receipt: {
  artifactID: string
  title: string
  bytes: number
  warnings?: string[]
}): string {
  const lines = [
    `Wrote "${receipt.title}" (artifact ${receipt.artifactID}, ${receipt.bytes} bytes).`,
  ]
  for (const warning of receipt.warnings ?? []) lines.push(`Warning: ${warning}`)
  return lines.join("\n")
}

function call(deps: ToolDeps) {
  return async (args: unknown): Promise<ToolCallResult> => {
    const result = await writeApp(args, deps)
    if (!result.ok) {
      return {
        text: `Artifact not written. Fix exactly this and retry at most twice: ${result.error}`,
        isError: true,
      }
    }
    return { text: formatSuccess(result.value), isError: false }
  }
}

export async function main(): Promise<void> {
  const env = loadToolEnv()
  await serveStdio({
    input: process.stdin,
    output: process.stdout,
    call: call({ bffUrl: env.bffUrl, token: env.token }),
  })
}

await main()
