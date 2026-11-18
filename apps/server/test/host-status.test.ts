import { describe, expect, it, vi } from "vitest"
import type { InfoResponse } from "@openchat/contracts"
import { json, login, makeServer } from "./helpers"
import type { TestServer } from "./helpers"

const CODE_ENV = {
  CODE_HOST_ORIGIN: "http://code.example:8090",
  CODE_TICKET_SECRET: "test-code-ticket-secret",
  CODE_STATUS_TIMEOUT_MS: "50",
}

async function readInfo(server: TestServer): Promise<InfoResponse> {
  const cookie = await login(server)
  const response = await server.app.request("/api/info", { headers: { cookie } })
  expect(response.status).toBe(200)
  return json<InfoResponse>(response)
}

describe("/api/info host degradation", () => {
  it("answers 200 when every host call fails and keeps the independent probes", async () => {
    const server = makeServer({
      env: CODE_ENV,
      codeProbe: async () => ({ reachable: false }),
      appsProbe: async () => ({ servers: [], skills: [] }),
    })
    for (const method of ["info", "listModels", "listAgents"] as const) {
      vi.spyOn(server.backend, method).mockRejectedValue(
        new Error("upstream host down: ticket-secret"),
      )
    }

    const cookie = await login(server)
    const response = await server.app.request("/api/info", { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")

    const body = await json<InfoResponse>(response)
    expect(body.host).toEqual({ reachable: false })
    expect(body.server).toBeNull()
    expect(body.models).toEqual([])
    expect(body.agents).toEqual([])
    // The Code and apps probes fail and answer independently of the host.
    expect(body.code.configured).toBe(true)
    expect(body.apps.available).toBe(true)

    const text = JSON.stringify(body)
    expect(text).not.toContain("upstream host down")
    expect(text).not.toContain("ticket-secret")
  })

  it("treats a refused OPENCODE_URL exactly like any other host outage", async () => {
    const methods = ["info", "listModels", "listAgents"] as const
    const refused = makeServer()
    for (const method of methods) {
      vi.spyOn(refused.backend, method).mockRejectedValue(
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4096"), {
          code: "ECONNREFUSED",
        }),
      )
    }
    const unavailable = makeServer()
    for (const method of methods) {
      vi.spyOn(unavailable.backend, method).mockRejectedValue(
        new Error("The OpenCode host is not reachable"),
      )
    }

    const refusedBody = await readInfo(refused)
    const unavailableBody = await readInfo(unavailable)

    // Same status, same shape, same null/empty fragments: a refused tunnel is
    // not a distinct state with its own code path in the BFF.
    expect(refusedBody).toEqual(unavailableBody)
    expect(refusedBody.host).toEqual({ reachable: false })
    expect(refusedBody.server).toBeNull()
    expect(JSON.stringify(refusedBody)).not.toContain("ECONNREFUSED")
  })

  it("keeps the reachable answer of a partial failure", async () => {
    const server = makeServer()
    vi.spyOn(server.backend, "listModels").mockRejectedValue(new Error("models down"))

    const body = await readInfo(server)
    expect(body.host).toEqual({ reachable: true })
    expect(body.server).toMatchObject({ mode: "fake", workspace: "/workspace" })
    expect(body.models).toEqual([])
    expect(body.agents).toEqual([
      { id: "build", name: "Build", description: "Deterministic scenario runner" },
    ])
  })

  it("reports a healthy fake host as reachable", async () => {
    const server = makeServer()

    const body = await readInfo(server)
    expect(body.host).toEqual({ reachable: true })
    expect(body.server).toMatchObject({ mode: "fake" })
    expect(body.models.length).toBeGreaterThan(0)
    expect(body.agents.length).toBeGreaterThan(0)
  })
})
