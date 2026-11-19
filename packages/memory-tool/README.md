# @openchat/memory-tool

The local MCP server for agent memory. It exposes eight batch-first tools
(`mem_index`, `mem_find`, `mem_get`, `mem_write`, `mem_update`, `mem_delete`,
`mem_prune`, `mem_stats`) and is a **thin client**: every call is a
`POST /internal/memory` to the BFF with the shared internal token. It never
touches a store file. See `docs/implementation/34-memory.md` for the contract.

```
model ──tools/call──▶ this server ──POST /internal/memory──▶ BFF ──▶ store
                       (op + args JSON)            (bearer token)   (BFF only)
```

## Run

```bash
pnpm install
pnpm --filter @openchat/memory-tool run start   # stdio MCP server
```

| Variable | Meaning |
| --- | --- |
| `OPENCHAT_BFF_URL` | BFF base URL; defaults to `http://127.0.0.1:8787`. |
| `MEMORY_INTERNAL_TOKEN` | Bearer token for `POST /internal/memory`, the same value the BFF reads. Required. |

## Test

```bash
pnpm --filter @openchat/memory-tool run test
```

The suite stubs the BFF through an injected `fetch` and opens no socket or port.
