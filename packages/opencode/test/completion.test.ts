import type { OpenCodeClient } from "@opencode/client"
import { describe, expect, it, vi } from "vitest"
import { FakeBackend } from "../src/fake"
import { FAKE_MODELS } from "../src/fake-completion"
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

const hostModel = {
  modelID: "gpt-x",
  name: "GPT X",
  providerID: "openai",
  variants: [{ id: "fast" }, { id: "slow" }],
  limit: { context: 128_000 },
  capabilities: { tools: true, input: ["text", "image"], output: ["text", "reasoning"] },
  status: "deprecated",
}

describe("completion catalogue and forwarding", () => {
  it("exposes a non-empty fake catalogue with variants and a deprecated model", async () => {
    const backend = new FakeBackend()
    expect(await backend.listModels()).toEqual(FAKE_MODELS)
    expect(FAKE_MODELS.some((model) => model.variants.length >= 2)).toBe(true)
    expect(FAKE_MODELS.some((model) => model.status === "deprecated")).toBe(true)
    expect(FAKE_MODELS.filter((model) => model.default)).toHaveLength(1)
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
      variant: "thorough",
      agent: "build",
    })
    expect(backend.recordedPrompt(session.id)).toEqual({
      text: "hello",
      model: "fake/echo",
      variant: "thorough",
      agent: "build",
    })
  })

  it("maps variants, capabilities, provider name, context and status from the host", async () => {
    const backend = liveBackend(
      liveClient({
        model: { list: async () => ({ data: [hostModel] }) },
        provider: { list: async () => ({ data: [{ id: "openai", name: "OpenAI" }] }) },
        session: { switchModel: async () => undefined },
      }),
    )
    expect(await backend.listModels()).toEqual([
      {
        id: "gpt-x",
        name: "GPT X",
        providerID: "openai",
        providerName: "OpenAI",
        variants: ["fast", "slow"],
        contextLimit: 128_000,
        capabilities: { tools: true, reasoning: true, image: true },
        status: "deprecated",
      },
    ])
  })

  it("applies the live model, its variant and the agent with session switches", async () => {
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
      model: { list: async () => ({ data: [hostModel] }) },
      provider: { list: async () => ({ data: [{ id: "openai", name: "OpenAI" }] }) },
      session: { switchModel, switchAgent, prompt },
    })
    const backend = liveBackend(client)
    // `/api/info` warms the host metadata before any prompt arrives.
    await backend.listModels()

    await backend.prompt("ses_1", {
      text: "hi", model: "gpt-x", variant: "slow", agent: "build",
    })

    expect(switchModel).toHaveBeenCalledWith({
      sessionID: "ses_1",
      model: { id: "gpt-x", providerID: "openai", variant: "slow" },
    })
    expect(switchAgent).toHaveBeenCalledWith({ sessionID: "ses_1", agent: "build" })
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ text: "hi" }))
    expect(calls).toEqual(["model", "agent", "prompt"])
  })

  it("drops a variant the host no longer offers", async () => {
    const switchModel = vi.fn(async () => undefined)
    const backend = liveBackend(
      liveClient({
        model: { list: async () => ({ data: [hostModel] }) },
        session: { switchModel, prompt: async () => ({ id: "msg_1" }) },
      }),
    )
    await backend.listModels()
    await backend.prompt("ses_1", { text: "hi", model: "gpt-x", variant: "gone" })
    expect(switchModel).toHaveBeenCalledWith({
      sessionID: "ses_1",
      model: { id: "gpt-x", providerID: "openai" },
    })
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
