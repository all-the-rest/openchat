import { MemoryStore } from "@openchat/memory-store"
import { loadMemoryToolEnv } from "./env"
import { serveStdio } from "./mcp"
import type { MemoryNotifier } from "./run"
import { runMemoryTool } from "./run"

/**
 * Entry point for the MCP client. Configuration is read once; the server then
 * answers JSON-RPC on stdin/stdout. Every tool reads and writes the same
 * directory the BFF uses, so a fact is visible in the next session's index.
 */

function createNotifier(bffUrl: string, token: string): MemoryNotifier | undefined {
  if (!bffUrl || !token) return undefined
  return async () => {
    const response = await fetch(`${bffUrl}/internal/memory/changed`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(2_000),
    })
    // The write already happened; a missing refresh is not a write failure.
    if (!response.ok) return
  }
}

export async function main(): Promise<void> {
  const env = loadMemoryToolEnv()
  const store = new MemoryStore({ dir: env.dir })
  const notify = createNotifier(env.bffUrl, env.token)
  await serveStdio({
    input: process.stdin,
    output: process.stdout,
    call: (name, args) => runMemoryTool(name, args, { store, notify }),
  })
}

await main()
