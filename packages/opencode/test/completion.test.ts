import type { OpenCodeClient } from "@opencode/client"
import { describe, expect, it, vi } from "vitest"
import { FakeBackend } from "../src/fake"
import { LiveBackend } from "../src/live"

function liveClient(overrides: Record<string, unknown>): OpenCodeClient {
  return overrides as unknown as OpenCodeClient
}

function liveBackend(client: OpenCodeClient): LiveBackend {
  return new LiveBackend({
    baseUrl: "http://unused",
    password: "unused",
    workspace: "/workspace",
    client,
  })
}

describe("completion catalogue and forwarding", () => {
  it("exposes a non-empty fake catalogue", async () => {
    const backend = new FakeBackend()
    expect(await backend.listModels()).toEqual([
      { id: "fake/echo", name: "Fake Echo", providerID: "fake", contextLimit: 128_000 },
    ])
    expect(await backend.listAgents()).toEqual([
      { id: "build", name: "Build", description: "Deterministic scenario runner" },
    ])
  })

  it("records the persisted choice on the fake without changing the answer", async () => {
    const backend = new FakeBackend({ delayMs: 0 })
    const session = await backend.createSession({ directory: "/workspace" })
    await backend.prompt(session.id, {
      text: "hello",
      model: "fake/echo",
      agent: "build",
    })
    expect(backend.recordedPrompt(session.id)).toEqual({
      text: "hello",
      model: "fake/echo",
      agent: "build",
    })
  })

  it("applies the live model and agent with session switches before the prompt", async () => {
    const calls: string[] = []
    const switchModel = vi.fn(async () => {
      calls.push("model")
    })
    const switchAgent = vi.fn(async () => {
      calls.push("agent")
    })
    const prompt = vi.fn(async () => {
      calls.push("prompt")
      return { id: "msg_1" }
    })
    const client = liveClient({
      model: {
        list: async () => ({
          data: [{ modelID: "gpt-x", name: "GPT X", providerID: "openai" }],
        }),
      },
      session: { switchModel, switchAgent, prompt },
    })
    const backend = liveBackend(client)
    // `/api/info` warms the provider map before any prompt arrives.
    await backend.listModels()

    await backend.prompt("ses_1", { text: "hi", model: "gpt-x", agent: "build" })

    expect(switchModel).toHaveBeenCalledWith({
      sessionID: "ses_1",
      model: { id: "gpt-x", providerID: "openai" },
    })
    expect(switchAgent).toHaveBeenCalledWith({ sessionID: "ses_1", agent: "build" })
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ text: "hi" }))
    expect(calls).toEqual(["model", "agent", "prompt"])
  })

  it("publishes the host's context window only when it has one", async () => {
    const backend = liveBackend(
      liveClient({
        model: {
          list: async () => ({
            data: [
              {
                modelID: "big",
                name: "Big",
                providerID: "p",
                limit: { context: 200_000, output: 8_000 },
              },
              { modelID: "plain", name: "Plain", providerID: "p" },
            ],
          }),
        },
      }),
    )
    expect(await backend.listModels()).toEqual([
      { id: "big", name: "Big", providerID: "p", contextLimit: 200_000 },
      { id: "plain", name: "Plain", providerID: "p" },
    ])
  })

  it("ignores an unknown model but still sends the prompt", async () => {
    const switchModel = vi.fn(async () => undefined)
    const prompt = vi.fn(async () => ({ id: "msg_1" }))
    const backend = liveBackend(
      liveClient({
        model: { list: async () => ({ data: [{ modelID: "known", name: "K", providerID: "p" }] }) },
        session: { switchModel, prompt },
      }),
    )
    await backend.listModels()
    await backend.prompt("ses_1", { text: "hi", model: "missing" })
    expect(switchModel).not.toHaveBeenCalled()
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it("forwards neither field when the browser made no choice", async () => {
    const switchModel = vi.fn(async () => undefined)
    const switchAgent = vi.fn(async () => undefined)
    const backend = liveBackend(
      liveClient({ session: { switchModel, switchAgent, prompt: async () => ({ id: "m" }) } }),
    )
    await backend.prompt("ses_1", { text: "hi" })
    expect(switchModel).not.toHaveBeenCalled()
    expect(switchAgent).not.toHaveBeenCalled()
  })
})
