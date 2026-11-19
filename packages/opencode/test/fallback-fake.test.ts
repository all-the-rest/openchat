import type { OpenCodeClient } from "@opencode/client"
import { EVENT } from "@openchat/contracts"
import type { EventEnvelope } from "@openchat/contracts"
import { describe, expect, it, vi } from "vitest"
import { FakeBackend, resolveScenario } from "../src"
import { applyCompletion } from "../src/live-model"

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function runUntilTerminal(
  backend: FakeBackend,
  sessionID: string,
  text: string,
): Promise<EventEnvelope[]> {
  const events: EventEnvelope[] = []
  const controller = new AbortController()
  const done = (async () => {
    for await (const event of backend.subscribe(controller.signal)) {
      events.push(event)
      if (
        event.type === EVENT.executionSucceeded ||
        event.type === EVENT.executionFailed ||
        event.type === EVENT.interrupted
      ) {
        controller.abort()
        break
      }
    }
  })()
  await backend.prompt(sessionID, { text })
  await withTimeout(done, 2000)
  return events
}

describe("fallback fake support", () => {
  it("resolves the fallback scenario prefix", () => {
    expect(resolveScenario("fallback: x", "default")).toBe("fallback")
    expect(resolveScenario("fallback: x", "rich")).toBe("fallback")
  })

  it("emits a retryable rate-limit failure before any text", async () => {
    const backend = new FakeBackend({ delayMs: 0 })
    const session = await backend.createSession({ directory: "/workspace" })
    const events = await runUntilTerminal(backend, session.id, "fallback: retry")

    const failedIndex = events.findIndex((event) => event.type === EVENT.executionFailed)
    expect(failedIndex).toBeGreaterThanOrEqual(0)
    const failure = events[failedIndex]
    expect(failure?.data.code).toBe("rate_limit")
    expect(failure?.data.retryable).toBe(true)
    expect(
      events.slice(0, failedIndex).some((event) => event.type === EVENT.textDelta),
    ).toBe(false)

    const messages = await backend.listMessages(session.id)
    const assistant = messages.find((message) => message.role === "assistant")
    expect(assistant?.status).toBe("error")
    expect(
      assistant?.parts.some((part) => part.type === "text"),
    ).toBe(false)
  })

  it("records the full model ref of a prompt", async () => {
    const backend = new FakeBackend({ delayMs: 0 })
    const session = await backend.createSession({ directory: "/workspace" })
    const modelRef = { providerID: "backup", modelID: "backup/model", variant: "fast" }
    await backend.prompt(session.id, { text: "hello", modelRef })
    expect(backend.recordedPrompt(session.id)?.modelRef).toEqual(modelRef)
  })

  it("switches to the full ref without a catalogue lookup", async () => {
    const switchModel = vi.fn(async () => undefined)
    const client = { session: { switchModel } } as unknown as OpenCodeClient
    const providers = vi.fn(async () => new Map())
    const modelRef = { providerID: "backup", modelID: "backup/model", variant: "fast" }

    await applyCompletion(client, "ses_1", { modelRef }, providers)

    expect(switchModel).toHaveBeenCalledWith({
      sessionID: "ses_1",
      model: { id: "backup/model", providerID: "backup", variant: "fast" },
    })
    expect(providers).not.toHaveBeenCalled()

    await applyCompletion(client, "ses_1", {
      modelRef: { providerID: "backup", modelID: "backup/model" },
    }, providers)

    expect(switchModel).toHaveBeenLastCalledWith({
      sessionID: "ses_1",
      model: { id: "backup/model", providerID: "backup" },
    })
    expect(providers).not.toHaveBeenCalled()
  })
})
