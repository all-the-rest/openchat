import { describe, expect, it } from "vitest"
import { FakeBackend } from "../src"
import {
  FAKE_SUBAGENT_PARENT_ID,
  FAKE_SUBAGENT_PARENT_TITLE,
} from "../src/fake-seed"

const BOUNDARY = "msg_subagent_parent_assistant"

describe("FakeBackend.forkSession", () => {
  it("creates a branch before the message and leaves the original untouched", async () => {
    const backend = new FakeBackend({ seedSubagents: true, now: () => 1000 })
    const before = await backend.listMessages(FAKE_SUBAGENT_PARENT_ID)

    const fork = await backend.forkSession(FAKE_SUBAGENT_PARENT_ID, BOUNDARY)

    expect(fork.branchOf).toBe(FAKE_SUBAGENT_PARENT_ID)
    expect(fork.branchBefore).toBe(BOUNDARY)
    expect(fork.parentID).toBeUndefined()
    // A fork inherits the title; it does not rename the conversation.
    expect(fork.title).toBe(FAKE_SUBAGENT_PARENT_TITLE)

    const history = await backend.listMessages(fork.id)
    expect(history.map((message) => message.id)).toEqual(["msg_subagent_parent_user"])
    expect(history[0]?.sessionID).toBe(fork.id)

    const after = await backend.listMessages(FAKE_SUBAGENT_PARENT_ID)
    expect(after).toEqual(before)
    expect((await backend.listSessions()).map((session) => session.id)).toContain(fork.id)
  })

  it("rejects an unknown boundary message without creating a session", async () => {
    const backend = new FakeBackend({ seedSubagents: true, now: () => 1000 })
    const count = (await backend.listSessions()).length

    await expect(
      backend.forkSession(FAKE_SUBAGENT_PARENT_ID, "msg_missing"),
    ).rejects.toMatchObject({ code: "invalid" })
    expect(await backend.listSessions()).toHaveLength(count)
  })

  it("rejects an unknown session", async () => {
    const backend = new FakeBackend({ delayMs: 0 })
    await expect(backend.forkSession("ses_missing", "msg_1")).rejects.toMatchObject({
      code: "not_found",
    })
  })
})
