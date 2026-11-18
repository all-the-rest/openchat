import { describe, expect, it } from "vitest"
import { eventEnvelopeSchema, messageSchema } from "@openchat/contracts"
import type { Message } from "@openchat/contracts"
import type {
  SessionInfo as OpenCodeSessionInfo,
  SessionMessageInfo,
  V2Event,
} from "@opencode/client"
import fixture from "../fixtures/contract-sample.json"
import { normalizeEvent, normalizeMessage, normalizeSession } from "../src/live"

describe("contract fixture", () => {
  it("decodes a session into the normalized shape", () => {
    const session = normalizeSession(fixture.session as unknown as OpenCodeSessionInfo)
    expect(session).toEqual({
      id: "ses_fixture",
      title: "Redacted fixture session",
      directory: "/workspace",
      created: 1_700_000_000_000,
      updated: 1_700_000_001_000,
    })
  })

  it("keeps a host parent link and omits it for a normal chat", () => {
    const child = normalizeSession({
      id: "ses_child",
      parentID: "ses_parent",
      title: "Subagent run",
      time: { created: 1, updated: 2 },
      location: { directory: "/workspace" },
    } as unknown as OpenCodeSessionInfo)
    expect(child.parentID).toBe("ses_parent")

    const plain = normalizeSession({
      id: "ses_plain",
      title: "Normal chat",
      time: { created: 1, updated: 2 },
      location: { directory: "/workspace" },
    } as unknown as OpenCodeSessionInfo)
    expect(plain.parentID).toBeUndefined()
    expect("parentID" in plain).toBe(false)
  })

  it("maps reported tokens and omits an empty report", () => {
    const base = fixture.session as unknown as OpenCodeSessionInfo
    const reported = normalizeSession({
      ...base,
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 7, write: 0 } },
    })
    expect(reported.usage).toEqual({ input: 10, output: 5, reasoning: 2, cache: { read: 7, write: 0 } })

    const empty = normalizeSession({
      ...base,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    expect(empty.usage).toBeUndefined()
  })

  it("decodes messages and validates them against the contract", () => {
    const messages = (fixture.messages as unknown as SessionMessageInfo[])
      .map((entry) => normalizeMessage(entry))
      .filter((entry): entry is Message => entry !== null)

    expect(messages).toHaveLength(2)

    const user = messages[0]
    expect(user?.role).toBe("user")
    expect(user?.status).toBe("complete")
    expect(user?.parts[0]).toEqual({
      type: "text",
      id: "msg_fixture_user_text",
      text: "Redacted example prompt",
    })

    const assistant = messages[1]
    expect(assistant?.role).toBe("assistant")
    expect(assistant?.status).toBe("complete")
    expect(assistant?.parts.map((part) => part.type)).toEqual(["reasoning", "text", "tool"])
    const tool = assistant?.parts[2]
    expect(tool).toMatchObject({
      type: "tool",
      id: "call_fixture",
      name: "read",
      status: "success",
      output: "Example tool output.",
    })

    for (const message of messages) {
      expect(messageSchema.safeParse(message).success).toBe(true)
    }
  })

  it("decodes events into normalized envelopes", () => {
    const envelopes = (fixture.events as unknown as V2Event[]).map((event) =>
      normalizeEvent(event),
    )

    expect(envelopes[0]?.data).toEqual({
      sessionID: "ses_fixture",
      messageID: "msg_fixture_assistant",
      partID: "msg_fixture_assistant_text_0",
      delta: "Redacted",
    })
    expect(envelopes[1]?.durable).toEqual({
      aggregateID: "ses_fixture",
      seq: 1,
      version: 1,
    })
    expect(envelopes[2]?.type).toBe("session.interrupted")

    for (const envelope of envelopes) {
      expect(eventEnvelopeSchema.safeParse(envelope).success).toBe(true)
    }
  })
})
