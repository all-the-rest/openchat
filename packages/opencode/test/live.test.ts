import { describe, expect, it } from "vitest"
import type { EventEnvelope, ToolPart } from "@openchat/contracts"
import type { OpenCodeClient, V2Event } from "@opencode/client"
import { LiveBackend } from "../src/live"
import { createToolEventState, normalizeEvent } from "../src/live"
import { event, gatedStream, waitFor } from "./live-helpers"

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

describe("live idle completion", () => {
  it("uses the tracked assistant message id for session.idle", () => {
    const state = createToolEventState()
    normalizeEvent(
      event({
        type: "session.text.delta",
        data: {
          sessionID: "ses_live",
          assistantMessageID: "msg_live",
          ordinal: 0,
          delta: "hello",
        },
      }),
      state,
    )

    const idle = normalizeEvent(
      event({ type: "session.idle", data: { sessionID: "ses_live" } }),
      state,
    )
    expect(idle.type).toBe("session.message.completed")
    expect(idle.data).toEqual({ sessionID: "ses_live", messageID: "msg_live" })
  })

  it("keeps session.idle distinct when no assistant message is known", () => {
    const idle = normalizeEvent(
      event({ type: "session.idle", data: { sessionID: "ses_live" } }),
      createToolEventState(),
    )
    expect(idle.type).toBe("session.idle")
    expect(idle.data).toEqual({ sessionID: "ses_live" })
    expect("messageID" in idle.data).toBe(false)
  })
})

describe("live fan-out", () => {
  it("opens one client subscription and delivers each event once per subscriber", async () => {
    const events = [
      event({
        id: "evt_one",
        type: "session.text.delta",
        data: {
          sessionID: "ses_live",
          assistantMessageID: "msg_live",
          ordinal: 0,
          delta: "one",
        },
      }),
      event({
        id: "evt_two",
        type: "session.text.delta",
        data: {
          sessionID: "ses_live",
          assistantMessageID: "msg_live",
          ordinal: 0,
          delta: "two",
        },
      }),
    ]
    const { stream, release, returned } = gatedStream(events)
    let subscriptions = 0
    const client = {
      event: {
        subscribe: () => {
          subscriptions += 1
          return stream
        },
      },
    } as unknown as OpenCodeClient

    const backend = new LiveBackend({
      baseUrl: "http://unused",
      password: "unused",
      workspace: "/workspace",
      client,
    })

    const first: EventEnvelope[] = []
    const second: EventEnvelope[] = []
    const firstController = new AbortController()
    const secondController = new AbortController()
    const runFirst = (async () => {
      for await (const event of backend.subscribe(firstController.signal)) first.push(event)
    })()
    const runSecond = (async () => {
      for await (const event of backend.subscribe(secondController.signal)) second.push(event)
    })()

    // Both consumers are attached to the same upstream subscription before it
    // emits anything.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(subscriptions).toBe(1)
    release()

    await waitFor(() => first.length === 2 && second.length === 2, "both subscribers")
    expect(first.map((entry) => entry.id)).toEqual(second.map((entry) => entry.id))
    expect(new Set(first.map((entry) => entry.id)).size).toBe(2)
    expect(subscriptions).toBe(1)

    firstController.abort()
    secondController.abort()
    await Promise.all([runFirst, runSecond])
    // The last subscriber leaving closes the single upstream iterator.
    await waitFor(() => returned() === 1, "upstream close")
  })
})
