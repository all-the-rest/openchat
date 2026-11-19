import { describe, expect, it, vi } from "vitest"
import type { OpenCodeClient } from "@opencode/client"
import { LiveBackend } from "../src/live"

function backend(client: Record<string, unknown>): LiveBackend {
  return new LiveBackend({
    baseUrl: "http://unused",
    password: "unused",
    workspace: "/workspace",
    client: client as unknown as OpenCodeClient,
  })
}

/** The declared 404 the host's own client offers for a gone session. */
function sessionNotFound(): Error {
  return Object.assign(new Error("session not found"), {
    _tag: "SessionNotFoundError",
    sessionID: "ses_missing",
  })
}

describe("live session pre-reads", () => {
  it("maps a failed rename read to unavailable instead of not_found", async () => {
    const update = vi.fn()
    const live = backend({
      session: {
        get: async () => {
          throw new Error("socket hang up")
        },
        update,
      },
    })

    await expect(live.renameSession("ses_live", "New title")).rejects.toMatchObject({
      code: "unavailable",
    })
    expect(update).not.toHaveBeenCalled()
  })

  it("keeps an explicitly missing session a not_found", async () => {
    const update = vi.fn()
    const live = backend({
      session: {
        get: async () => {
          throw sessionNotFound()
        },
        update,
      },
    })

    await expect(live.renameSession("ses_missing", "New title")).rejects.toMatchObject({
      code: "not_found",
    })
    expect(update).not.toHaveBeenCalled()
  })

  it("treats an undeclared 404 status as a missing session", async () => {
    const live = backend({
      session: {
        get: async () => {
          throw Object.assign(new Error("UnexpectedStatus: 404"), {
            reason: "UnexpectedStatus",
            cause: { status: 404 },
          })
        },
        update: vi.fn(),
      },
    })

    await expect(live.renameSession("ses_missing", "New title")).rejects.toMatchObject({
      code: "not_found",
    })
  })

  it("maps a failed delete read to unavailable and does not remove", async () => {
    const remove = vi.fn()
    const live = backend({
      session: {
        get: async () => {
          throw new Error("connection reset")
        },
        remove,
      },
    })

    await expect(live.deleteSession("ses_live")).rejects.toMatchObject({
      code: "unavailable",
    })
    expect(remove).not.toHaveBeenCalled()
  })

  it("keeps an explicitly missing session a not_found on delete", async () => {
    const remove = vi.fn()
    const live = backend({
      session: {
        get: async () => {
          throw sessionNotFound()
        },
        remove,
      },
    })

    await expect(live.deleteSession("ses_missing")).rejects.toMatchObject({
      code: "not_found",
    })
    expect(remove).not.toHaveBeenCalled()
  })
})
