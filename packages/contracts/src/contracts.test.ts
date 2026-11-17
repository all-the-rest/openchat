import { describe, expect, it } from "vitest"
import {
  EVENT,
  eventEnvelopeSchema,
  messageSchema,
  partSchema,
  promptRequestSchema,
} from "../src/index"

describe("contracts", () => {
  it("keeps event names unique", () => {
    const names = Object.values(EVENT)
    expect(new Set(names).size).toBe(names.length)
  })

  it("accepts a message with every part kind", () => {
    const message = {
      id: "msg_1",
      sessionID: "ses_1",
      role: "assistant" as const,
      created: 1,
      status: "complete" as const,
      parts: [
        { type: "text", id: "part_1", text: "hello" },
        { type: "reasoning", id: "part_2", text: "thinking" },
        { type: "tool", id: "part_3", callID: "call_1", name: "bash", status: "success" },
        { type: "error", id: "part_4", message: "boom", retryable: true },
      ],
    }

    expect(messageSchema.parse(message)).toEqual(message)
  })

  it("rejects an unknown part and an unknown status", () => {
    expect(partSchema.safeParse({ type: "image", id: "part_1" }).success).toBe(false)
    expect(
      messageSchema.safeParse({
        id: "msg_1",
        sessionID: "ses_1",
        role: "assistant",
        created: 1,
        status: "finished",
        parts: [],
      }).success,
    ).toBe(false)
  })

  it("bounds the prompt length", () => {
    expect(promptRequestSchema.safeParse({ text: "   " }).success).toBe(true)
    expect(promptRequestSchema.safeParse({ text: "" }).success).toBe(false)
    expect(promptRequestSchema.safeParse({ text: "a".repeat(32_001) }).success).toBe(false)
  })

  it("accepts only queue as an explicit delivery mode", () => {
    expect(promptRequestSchema.safeParse({ text: "hi", delivery: "queue" }).success).toBe(true)
    expect(promptRequestSchema.safeParse({ text: "hi" }).success).toBe(true)
    expect(promptRequestSchema.safeParse({ text: "hi", delivery: "steer" }).success).toBe(false)
  })

  it("requires an event type and data object", () => {
    expect(
      eventEnvelopeSchema.safeParse({ id: "evt_1", created: 1, type: EVENT.textDelta, data: {} })
        .success,
    ).toBe(true)
    expect(eventEnvelopeSchema.safeParse({ id: "evt_1", created: 1 }).success).toBe(false)
  })
})
