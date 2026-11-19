import type { MemoryOpResult } from "@openchat/contracts"
import { loadToolEnv } from "./env"
import { serveStdio } from "./mcp"
import type { ToolCall } from "./mcp"
import { callMemoryTool } from "./tool"
import type { ToolDeps } from "./tool"

/**
 * Entry point for the MCP client. Reads its configuration once, then answers
 * JSON-RPC on stdin/stdout until the client closes the pipe. Every call is a
 * thin POST through the BFF; a BFF failure becomes `isError: true` with its
 * fixed code/message line, never an upstream HTML fragment or a leaked token.
 */

/** Every op returns a JSON-safe result object; keep the wire format compact. */
function compactText(result: MemoryOpResult): string {
  return JSON.stringify(result)
}

function call(deps: ToolDeps): ToolCall {
  return async (name, args) => {
    const result = await callMemoryTool(name, args, deps)
    if (!result.ok) return { text: result.error, isError: true }
    return { text: compactText(result.result), isError: false }
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
