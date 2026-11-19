import { MemoryStore } from "@openchat/memory-store"
import { loadMemoryToolEnv } from "./env"
import { serveStdio } from "./mcp"
import type { ToolCallResult } from "./mcp"
import { notifyChanged } from "./notify"
import { runMemoryTool } from "./tools"
import type { ToolDeps } from "./tools"

/**
 * Entry point for the MCP client. Configuration is read once, then the server
 * answers JSON-RPC on stdin/stdout until the pipe closes. The shared store reads
 * and writes the same files as the BFF; the only network call is a best-effort
 * refresh notification after a mutation.
 */
function call(deps: ToolDeps) {
  return async (name: string, args: unknown): Promise<ToolCallResult> =>
    runMemoryTool(name, args, deps)
}

export async function main(): Promise<void> {
  const env = loadMemoryToolEnv()
  const store = new MemoryStore({ dir: env.dir })
  const deps: ToolDeps = {
    store,
    notify: () => notifyChanged({ bffUrl: env.bffUrl, token: env.token }),
  }
  await serveStdio({ input: process.stdin, output: process.stdout, call: call(deps) })
}

await main()
