import { describe, expect, it } from "vitest"
import type { OpenCodeClient } from "@opencode/client"
import { LiveBackend } from "../src/live"

describe("LiveBackend.forkSession", () => {
  it("forks before the message and maps the host marker onto branch fields", async () => {
    const calls: unknown[] = []
    const client = {
      session: {
        fork: async (input: unknown) => {
          calls.push(input)
          return {
            id: "ses_fork",
            parentID: "ses_parent",
            fork: {
              sessionID: "ses_parent",
              boundary: { type: "before", messageID: "msg_boundary" },
            },
            title: "Parent chat",
            time: { created: 5, updated: 6 },
            location: { directory: "/workspace" },
          }
        },
      },
    } as unknown as OpenCodeClient
    const backend = new LiveBackend({
      baseUrl: "http://unused",
      password: "unused",
      workspace: "/workspace",
      client,
    })

    const session = await backend.forkSession("ses_parent", "msg_boundary")

    expect(calls).toEqual([{ sessionID: "ses_parent", before: "msg_boundary" }])
    expect(session).toMatchObject({
      id: "ses_fork",
      title: "Parent chat",
      branchOf: "ses_parent",
      branchBefore: "msg_boundary",
    })
    // The host parent must not turn the branch into a subagent chat.
    expect(session.parentID).toBeUndefined()
  })
})
