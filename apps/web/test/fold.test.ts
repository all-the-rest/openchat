import type { EventEnvelope, Message, ToolPart } from "@openchat/contracts"
import { EVENT } from "@openchat/contracts"
import { describe, expect, it } from "vitest"
import { applyEvent } from "../src/state/fold"

const envelope = (
  type: string,
  data: Record<string, unknown>,
  id = "evt_1",
  created = 1000,
): EventEnvelope => ({ id, created, type, data })

const assistant = (parts: Message["parts"] = []): Message => ({
  id: "msg_1",
  sessionID: "ses_1",
  role: "assistant",
  parts,
  created: 1,
  status: "streaming",
})

const tool = (overrides: Partial<ToolPart> = {}): ToolPart => ({
  type: "tool",
  id: "tool_1",
  callID: "call_1",
  name: "read_file",
  status: "running",
  input: "src/index.ts",
  ...overrides,
})

describe("applyEvent", () => {
  it("appends text deltas by message and part and creates the message", () => {
    const first = applyEvent(
      [],
      envelope(EVENT.textDelta, {
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "part_1",
        delta: "Hello",
      }),
    )

    expect(first).toHaveLength(1)
    expect(first[0]?.parts).toEqual([{ type: "text", id: "part_1", text: "Hello" }])
    expect(first[0]?.status).toBe("streaming")

    const second = applyEvent(
      first,
      envelope(
        EVENT.textDelta,
        { sessionID: "ses_1", messageID: "msg_1", partID: "part_1", delta: " world" },
        "evt_2",
      ),
    )

    expect(second[0]?.parts).toHaveLength(1)
    expect(second[0]?.parts[0]).toEqual({ type: "text", id: "part_1", text: "Hello world" })
    // The input snapshot is untouched.
    expect(first[0]?.parts[0]).toEqual({ type: "text", id: "part_1", text: "Hello" })
  })

  it("keeps reasoning deltas in their own part", () => {
    const start = [assistant()]

    const withReasoning = applyEvent(
      start,
      envelope(EVENT.reasoningDelta, {
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "reason_1",
        delta: "Checking ",
      }),
    )
    const final = applyEvent(
      withReasoning,
      envelope(
        EVENT.reasoningDelta,
        { sessionID: "ses_1", messageID: "msg_1", partID: "reason_1", delta: "the tests" },
        "evt_2",
      ),
    )

    expect(final[0]?.parts).toHaveLength(1)
    expect(final[0]?.parts[0]).toEqual({
      type: "reasoning",
      id: "reason_1",
      text: "Checking the tests",
    })
  })

  it("replaces a tool part by id", () => {
    const start = [assistant([tool()])]

    const updated = applyEvent(
      start,
      envelope(EVENT.toolUpdated, {
        sessionID: "ses_1",
        messageID: "msg_1",
        part: tool({ status: "success", output: "file contents", endedAt: 1200 }),
      }),
    )

    expect(updated[0]?.parts).toHaveLength(1)
    const part = updated[0]?.parts[0]
    expect(part?.type).toBe("tool")
    if (part?.type === "tool") {
      expect(part.status).toBe("success")
      expect(part.output).toBe("file contents")
    }
    // Original reference still holds the old part.
    expect(start[0]?.parts[0]).toMatchObject({ status: "running" })
  })

  it("marks a message complete", () => {
    const start = [assistant([{ type: "text", id: "part_1", text: "Done" }])]

    const updated = applyEvent(
      start,
      envelope(EVENT.messageCompleted, { sessionID: "ses_1", messageID: "msg_1" }),
    )

    expect(updated[0]?.status).toBe("complete")
  })

  it("keeps a stopped snapshot stopped when the completion event has no status", () => {
    const start = [assistant([{ type: "text", id: "part_1", text: "Half" }])]

    const updated = applyEvent(
      start,
      envelope(EVENT.messageCompleted, {
        sessionID: "ses_1",
        messageID: "msg_1",
        message: {
          id: "msg_1",
          sessionID: "ses_1",
          role: "assistant",
          parts: [{ type: "text", id: "part_1", text: "Half" }],
          created: 1,
          status: "stopped",
        },
      }),
    )

    expect(updated[0]?.status).toBe("stopped")
  })

  it("adds snapshot parts that only exist in the completed message", () => {
    const start = [assistant([{ type: "text", id: "part_1", text: "Calling a tool" }])]

    const updated = applyEvent(
      start,
      envelope(EVENT.messageCompleted, {
        sessionID: "ses_1",
        message: {
          id: "msg_1",
          sessionID: "ses_1",
          role: "assistant",
          parts: [
            { type: "text", id: "part_1", text: "Calling a tool" },
            tool({ id: "tool_snapshot", callID: "call_snapshot", status: "success" }),
          ],
          created: 1,
          status: "complete",
        },
      }),
    )

    expect(updated[0]?.parts).toHaveLength(2)
    expect(updated[0]?.parts[1]).toMatchObject({
      type: "tool",
      id: "tool_snapshot",
      status: "success",
    })
  })

  it("replaces an existing snapshot part instead of duplicating it", () => {
    const start = [assistant([{ type: "text", id: "part_1", text: "Half" }])]

    const updated = applyEvent(
      start,
      envelope(EVENT.messageCompleted, {
        sessionID: "ses_1",
        message: {
          id: "msg_1",
          sessionID: "ses_1",
          role: "assistant",
          parts: [{ type: "text", id: "part_1", text: "The complete answer" }],
          created: 1,
          status: "complete",
        },
      }),
    )

    expect(updated[0]?.parts).toHaveLength(1)
    expect(updated[0]?.parts[0]).toEqual({
      type: "text",
      id: "part_1",
      text: "The complete answer",
    })
  })

  it("keeps a tool part the snapshot does not mention", () => {
    const start = [assistant([tool()])]

    const updated = applyEvent(
      start,
      envelope(EVENT.messageCompleted, {
        sessionID: "ses_1",
        message: {
          id: "msg_1",
          sessionID: "ses_1",
          role: "assistant",
          parts: [{ type: "text", id: "part_new", text: "Answer" }],
          created: 1,
          status: "complete",
        },
      }),
    )

    expect(updated[0]?.parts).toHaveLength(2)
    expect(updated[0]?.parts[0]).toMatchObject({ type: "tool", id: "tool_1" })
    expect(updated[0]?.parts[1]).toMatchObject({ type: "text", id: "part_new" })
  })

  it("adds an error part and sets the error status on session.error", () => {
    const start = [assistant([{ type: "text", id: "part_1", text: "Partial" }])]

    const updated = applyEvent(
      start,
      envelope(EVENT.error, {
        sessionID: "ses_1",
        messageID: "msg_1",
        message: "Provider overloaded",
        code: "provider_error",
        retryable: true,
      }),
    )

    expect(updated[0]?.status).toBe("error")
    expect(updated[0]?.parts).toHaveLength(2)
    expect(updated[0]?.parts[1]).toMatchObject({
      type: "error",
      message: "Provider overloaded",
      code: "provider_error",
      retryable: true,
    })
  })

  it("marks the message stopped on interrupt", () => {
    const start = [assistant([{ type: "text", id: "part_1", text: "Half an" }])]

    const updated = applyEvent(
      start,
      envelope(EVENT.interrupted, { sessionID: "ses_1", messageID: "msg_1" }),
    )

    expect(updated[0]?.status).toBe("stopped")
    expect(updated[0]?.parts).toHaveLength(1)
  })

  it("turns execution.failed into an error part", () => {
    const updated = applyEvent([], envelope(EVENT.executionFailed, {
      sessionID: "ses_1",
      message: "Execution failed",
    }))

    expect(updated).toHaveLength(1)
    expect(updated[0]?.status).toBe("error")
    expect(updated[0]?.parts[0]).toMatchObject({ type: "error", message: "Execution failed" })
  })

  it("ignores unknown events without copying the array", () => {
    const start = [assistant([{ type: "text", id: "part_1", text: "Hi" }])]

    const updated = applyEvent(start, envelope("session.unknown.event", { sessionID: "ses_1" }))

    expect(updated).toBe(start)
  })

  it("does not stack a second error card after a structured session.error", () => {
    const errored = applyEvent(
      [assistant([{ type: "text", id: "part_1", text: "Partial" }])],
      envelope(EVENT.error, {
        sessionID: "ses_1",
        messageID: "msg_1",
        message: "Provider overloaded",
        code: "provider_error",
      }),
    )

    const failed = applyEvent(
      errored,
      envelope(
        EVENT.executionFailed,
        { sessionID: "ses_1", messageID: "msg_1", message: "The run failed" },
        "evt_2",
      ),
    )

    expect(failed[0]?.parts.filter((part) => part.type === "error")).toHaveLength(1)
    expect(failed[0]?.status).toBe("error")
  })
})
