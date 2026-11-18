import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ROOT, block } from "./remote-deploy-fixtures"

/**
 * The edge fragment as text. Structural pins only — what a later edit could
 * silently undo: the SSE path in a handle without `encode`, the internal write
 * route refused at the edge, and no second auth layer.
 *
 * `caddy validate` and the routing probe are recorded in
 * docs/implementation/20-remote-deploy.md; they need the image, not this test.
 */

const CADDY = readFileSync(join(ROOT, "deploy", "remote", "Caddyfile.openchat"), "utf8")

function site(host: string): string {
  return block(CADDY, `${host}.__OPENCHAT_DOMAIN__ {`, "\n}")
}

describe("Caddy fragment", () => {
  it("serves the SSE path in a handle without encode and compresses the rest", () => {
    const chat = site("chat")
    const sse = block(chat, "\thandle /api/events* {", "\n\t}")
    const rest = block(chat, "\thandle {", "\n\t}")

    expect(sse).toContain("reverse_proxy openchat-bff:8787")
    expect(sse).toContain("flush_interval -1")
    expect(sse).toContain("header_up X-Forwarded-For {remote_host}")
    expect(sse).not.toMatch(/^\s*encode\b/m)
    expect(rest).toContain("encode zstd gzip")
    expect(rest).toContain("reverse_proxy openchat-bff:8787")
    expect(chat.indexOf("\thandle /api/events* {")).toBeLessThan(chat.indexOf("\thandle {"))

    // The Code host proxies OpenCode's event stream on the same path, so it
    // needs the same split; artifacts has no encode at all.
    const code = site("code")
    const codeSse = block(code, "\thandle /api/events* {", "\n\t}")
    const codeRest = block(code, "\thandle {", "\n\t}")
    expect(codeSse).toContain("reverse_proxy openchat-code-host:8090")
    expect(codeSse).not.toMatch(/^\s*encode\b/m)
    expect(codeRest).toContain("encode zstd gzip")
    expect(code.indexOf("\thandle /api/events* {")).toBeLessThan(code.indexOf("\thandle {"))
    expect(site("artifacts")).not.toMatch(/^\s*encode\b/m)
    expect(CADDY).not.toContain("@compressible")
    expect(CADDY.match(/encode zstd gzip/g)).toHaveLength(2)
  })

  it("refuses the internal write route at the edge before it reaches the BFF", () => {
    const chat = site("chat")
    const internal = block(chat, "\thandle /internal/* {", "\n\t}")

    // 404, not 403: the edge must not confirm that the route exists.
    expect(internal).toContain("respond 404")
    expect(internal).not.toMatch(/^\s*(encode|reverse_proxy)\b/m)
    // Before the catch-all, or the proxy would answer first.
    expect(chat.indexOf("\thandle /internal/* {")).toBeLessThan(chat.indexOf("\thandle {"))

    // The guard is Caddy-only: the in-network MCP tool talks to the BFF
    // directly, so nothing else may block /internal/*.
    const compose = readFileSync(join(ROOT, "deploy", "remote", "compose.yaml"), "utf8")
    expect(compose).toContain("OPENCHAT_BFF_URL: http://bff:8787")
    expect(compose).not.toContain("/internal")
  })

  it("declares three origins, SSE-safe proxying and app-level auth only", () => {
    for (const host of ["chat", "code", "artifacts"]) {
      expect(CADDY).toContain(`${host}.__OPENCHAT_DOMAIN__ {`)
    }
    expect(CADDY.match(/flush_interval -1/g)).toHaveLength(4)
    expect(CADDY.match(/header_up X-Forwarded-For \{remote_host\}/g)).toHaveLength(4)
    expect(CADDY).not.toMatch(/^\s*basic_auth\b/m)
    expect(CADDY).not.toMatch(/^\s*forward_auth\b/m)
    expect(CADDY).toContain("X-Frame-Options \"DENY\"")
  })
})
