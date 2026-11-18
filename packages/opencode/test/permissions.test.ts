import type { OpenCodeClient } from "@opencode/client"
import { describe, expect, it, vi } from "vitest"
import { BackendError } from "../src/errors"
import { FakeBackend } from "../src/fake"
import { LiveBackend } from "../src/live"
import { normalizeEvent } from "../src/live-events"
import { event } from "./live-helpers"

describe("fake permissions", () => {
  it("lists an ask, removes it on a reply and rejects an unknown id", async () => {
    const backend = new FakeBackend()
    const session = await backend.createSession({ directory: "/workspace" })
    const asked = backend.askPermission(session.id, "bash", "Run pnpm test", ["pnpm test"])
    expect(asked.id).toBe("per_1")

    expect(await backend.listPermissions(session.id)).toEqual([asked])
    await backend.replyPermission(session.id, asked.id, "once")
    expect(await backend.listPermissions(session.id)).toEqual([])

    await expect(backend.replyPermission(session.id, asked.id, "deny")).rejects.toMatchObject({
      code: "not_found",
    })
  })

  it("emits an answered event carrying the decision", async () => {
    const backend = new FakeBackend()
    const session = await backend.createSession({ directory: "/workspace" })
    const seen: string[] = []
    const controller = new AbortController()
    const stream = (async () => {
      for await (const envelope of backend.subscribe(controller.signal)) seen.push(envelope.type)
    })()

    const asked = backend.askPermission(session.id, "read", "Read a file")
    await backend.replyPermission(session.id, asked.id, "deny")
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    await stream

    expect(seen).toEqual(["permission.asked", "permission.replied"])
  })
})

describe("live permissions", () => {
  function backendWith(client: Record<string, unknown>): LiveBackend {
    return new LiveBackend({
      baseUrl: "http://unused",
      password: "unused",
      workspace: "/workspace",
      client: client as unknown as OpenCodeClient,
    })
  }

  it("maps the host request onto the flat permission contract", async () => {
    const backend = backendWith({
      permission: {
        list: async () => [
          {
            id: "per_9",
            sessionID: "ses_1",
            action: "bash",
            message: "Run a command",
            resources: ["pnpm test"],
          },
        ],
      },
    })
    expect(await backend.listPermissions("ses_1")).toEqual([
      {
        id: "per_9",
        sessionID: "ses_1",
        tool: "bash",
        action: "Run a command",
        resources: ["pnpm test"],
      },
    ])
  })

  it("maps deny to reject and once/always unchanged", async () => {
    const reply = vi.fn(async (_input: { decision: string }) => undefined)
    const backend = backendWith({
      permission: { get: async () => ({}), reply },
    })
    await backend.replyPermission("ses_1", "per_1", "deny")
    await backend.replyPermission("ses_1", "per_2", "once")
    await backend.replyPermission("ses_1", "per_3", "always")
    expect(reply.mock.calls.map(([input]) => input.decision)).toEqual([
      "reject",
      "once",
      "always",
    ])
  })

  it("turns a missing host request into not_found", async () => {
    const reply = vi.fn(async () => undefined)
    const backend = backendWith({
      permission: { get: async () => { throw new Error("missing") }, reply },
    })
    await expect(backend.replyPermission("ses_1", "missing", "once")).rejects.toBeInstanceOf(
      BackendError,
    )
    expect(reply).not.toHaveBeenCalled()
  })

  it("maps both SSE directions", () => {
    const asked = normalizeEvent(
      event({
        type: "permission.asked",
        data: {
          sessionID: "ses_1",
          id: "per_1",
          action: "bash",
          message: "Run a command",
          resources: ["pnpm test"],
        },
      }),
    )
    expect(asked).toMatchObject({
      type: "permission.asked",
      data: {
        sessionID: "ses_1",
        id: "per_1",
        tool: "bash",
        action: "Run a command",
        resources: ["pnpm test"],
      },
    })

    const replied = normalizeEvent(
      event({
        type: "permission.replied",
        data: { sessionID: "ses_1", requestID: "per_1", reply: "reject" },
      }),
    )
    expect(replied).toMatchObject({
      type: "permission.replied",
      data: { sessionID: "ses_1", requestID: "per_1", decision: "deny" },
    })
  })
})
