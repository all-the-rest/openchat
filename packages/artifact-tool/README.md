# @openchat/artifact-tool

The MCP server that writes interactive apps. One tool, `openchat_app_write`:
it validates one Preact JSX module, compiles it into a self-contained document
and stores that document through the BFF. See
[`docs/implementation/09-artifacts.md`](../../docs/implementation/09-artifacts.md)
for the contract, the validator table and the compiler deviation.

```
model ──tools/call──▶ this server ──POST /internal/artifacts──▶ BFF store
                       validate, compile, shell        (bearer token)
```

## Run

```bash
pnpm install                                   # esbuild + preact, once
pnpm --filter @openchat/artifact-tool run start   # stdio MCP server
```

The OpenCode entry (owner-owned `opencode.json`) is documented in
[`09-artifacts.md`](../../docs/implementation/09-artifacts.md#owner-step-the-mcp-entry).

| Variable | Meaning |
| --- | --- |
| `OPENCHAT_BFF_URL` | BFF base URL; defaults to `http://127.0.0.1:8787`. |
| `ARTIFACT_INTERNAL_TOKEN` | Bearer token for `POST /internal/artifacts`, the same value the BFF reads. Required. |

## Test

```bash
pnpm --filter @openchat/artifact-tool run test
```

The suite compiles real modules with esbuild in-process, stubs the BFF through
an injected `fetch` and opens no socket.
