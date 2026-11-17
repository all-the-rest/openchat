import { describe, expect, it } from "vitest"
import type { ToolPart } from "@openchat/contracts"
import type { V2Event } from "@opencode/client"
import { createToolEventState, normalizeEvent } from "../src/live"

const durable = { aggregateID: "ses_live", seq: 1, version: 1 }

function event(input: Record<string, unknown>): V2Event {
  return {
    id: `evt_${String(input.type)}`,
    created: 1_000,
    durable,
    ...input,
  } as unknown as V2Event
}

function toolPart(envelope: ReturnType<typeof normalizeEvent>): ToolPart {
  expect(envelope.type).toBe("session.tool.updated")
  return envelope.data.part as ToolPart
}

describe("live tool events", () => {
  it("maps name, streaming input and duration onto ToolPart", () => {
    const state = createToolEventState()

    const started = normalizeEvent(
      event({
        created: 1_000,
        type: "session.tool.input.started",
        data: {
          sessionID: "ses_live",
          assistantMessageID: "msg_live",
          id: "call_live",
          name: "read",
        },
      }),
      state,
    )
    expect(toolPart(started)).toMatchObject({
      type: "tool",
      id: "call_live",
      name: "read",
      status: "running",
      startedAt: 1_000,
    })

    const firstDelta = normalizeEvent(
      event({
        created: 1_050,
        type: "session.tool.input.delta",
        data: {
          sessionID: "ses_live",
          assistantMessageID: "msg_live",
          id: "call_live",
          delta: '{"path":',
        },
      }),
      state,
    )
    expect(toolPart(firstDelta)).toMatchObject({
      name: "read",
      status: "running",
      input: '{"path":',
      startedAt: 1_000,
    })

    const secondDelta = normalizeEvent(
      event({
        created: 1_060,
        type: "session.tool.input.delta",
        data: {
          sessionID: "ses_live",
          assistantMessageID: "msg_live",
          id: "call_live",
          delta: '"README.md"}',
        },
      }),
      state,
    )
    expect(toolPart(secondDelta).input).toBe('{"path":"README.md"}')

    const called = normalizeEvent(
      event({
        created: 1_100,
        type: "session.tool.called",
        data: {
          sessionID: "ses_live",
          assistantMessageID: "msg_live",
          id: "call_live",
          input: { path: "README.md" },
          executed: false,
        },
      }),
      state,
    )
    expect(toolPart(called)).toMatchObject({
      name: "read",
      input: '{"path":"README.md"}',
      startedAt: 1_000,
    })

    const success = normalizeEvent(
      event({
        created: 1_300,
        type: "session.tool.success",
        data: {
          sessionID: "ses_live",
          assistantMessageID: "msg_live",
          id: "call_live",
          content: [{ type: "text", text: "README contents" }],
          executed: true,
        },
      }),
      state,
    )
    expect(toolPart(success)).toMatchObject({
      name: "read",
      status: "success",
      output: "README contents",
      startedAt: 1_000,
      endedAt: 1_300,
    })
  })

  it("keeps the name from input.started on a failure", () => {
    const state = createToolEventState()
    normalizeEvent(
      event({
        created: 500,
        type: "session.tool.input.started",
        data: {
          sessionID: "ses_live",
          assistantMessageID: "msg_live",
          id: "call_second",
          name: "bash",
        },
      }),
      state,
    )

    const failed = normalizeEvent(
      event({
        created: 800,
        type: "session.tool.failed",
        data: {
          sessionID: "ses_live",
          assistantMessageID: "msg_live",
          id: "call_second",
          error: { type: "tool_error", message: "command failed" },
          executed: true,
        },
      }),
      state,
    )
    expect(toolPart(failed)).toMatchObject({
      name: "bash",
      status: "error",
      error: "command failed",
      startedAt: 500,
      endedAt: 800,
    })
  })

  it("does not invent a name when the stream never announced one", () => {
    // `session.tool.called` carries no name in the client types and
    // `session.tool.success`/`failed` only carry it optionally. The fallback is
    // an explicit placeholder, never a made-up tool name.
    const state = createToolEventState()
    const called = normalizeEvent(
      event({
        type: "session.tool.called",
        data: {
          sessionID: "ses_live",
          assistantMessageID: "msg_live",
          id: "call_unknown",
          input: {},
          executed: false,
        },
      }),
      state,
    )
    expect(toolPart(called).name).toBe("tool")
    expect(toolPart(called).startedAt).toBe(1_000)
  })
})
