import type { OpenCodeClient } from "@opencode/client"
import { describe, expect, it, vi } from "vitest"
import { FAKE_MODELS } from "../src/fake-completion"
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

describe("fake provider inventory", () => {
  it("starts without a model and makes one appear after a key connect", async () => {
    const backend = new FakeBackend({ seedModels: false })
    expect(await backend.listModels()).toEqual([])

    const [provider] = await backend.listProviders()
    expect(provider?.methods.map((method) => method.type)).toEqual(["key", "oauth", "command"])

    await backend.connectProviderKey({
      providerID: "fake-cloud",
      methodID: "api-key",
      key: "test-api-key-123",
      answer: { region: "eu" },
    })

    expect(await backend.listModels()).toEqual([
      FAKE_MODELS.find((model) => model.default),
    ])
    expect(backend.recordedProviders().connects).toEqual([
      {
        providerID: "fake-cloud",
        methodID: "api-key",
        label: null,
        keyLength: "test-api-key-123".length,
      },
    ])
    const [connected] = await backend.listProviders()
    expect(connected?.connected).toBe(true)
  })

  it("keeps the secret out of every record and probe", async () => {
    const backend = new FakeBackend({ seedModels: false })
    await backend.connectProviderKey({
      providerID: "fake-cloud",
      methodID: "api-key",
      key: "super-secret-key",
      answer: { region: "eu" },
    })
    expect(JSON.stringify(backend.recordedProviders().connects)).not.toContain("super-secret-key")
    expect(JSON.stringify(await backend.listProviders())).not.toContain("super-secret-key")
  })

  it("polls an OAuth attempt through pending to complete", async () => {
    let now = 0
    const backend = new FakeBackend({ seedModels: false, now: () => now, oauthDelayMs: 500 })
    const attempt = await backend.startProviderOAuth({
      providerID: "fake-cloud",
      methodID: "browser",
    })
    expect(await backend.providerOAuthStatus({ providerID: "fake-cloud", attemptID: attempt.id })).toBe(
      "pending",
    )
    now = 500
    expect(await backend.providerOAuthStatus({ providerID: "fake-cloud", attemptID: attempt.id })).toBe(
      "complete",
    )
    expect((await backend.listModels()).length).toBe(1)
  })

  it("cancels an OAuth attempt and rejects a later poll", async () => {
    const backend = new FakeBackend({ oauthDelayMs: 60_000 })
    const attempt = await backend.startProviderOAuth({
      providerID: "fake-cloud",
      methodID: "browser",
    })
    await backend.cancelProviderOAuth({ providerID: "fake-cloud", attemptID: attempt.id })
    await expect(
      backend.providerOAuthStatus({ providerID: "fake-cloud", attemptID: attempt.id }),
    ).rejects.toMatchObject({ code: "not_found" })
    expect(backend.recordedProviders()).toMatchObject({ oauthStarts: 1, oauthCancels: 1 })
  })

  it("applies the browser completion at session creation", async () => {
    const backend = new FakeBackend()
    const session = await backend.createSession({
      directory: "/workspace",
      model: "fake/echo",
      agent: "build",
    })
    expect(backend.sessionCompletion(session.id)).toEqual({ model: "fake/echo", agent: "build" })
  })
})

describe("live provider adapter", () => {
  it("reduces the host catalogue and marks the secret field", async () => {
    const backend = liveBackend(
      liveClient({
        integration: {
          list: async () => ({
            data: [
              {
                id: "cloud",
                name: "Cloud",
                methods: [
                  {
                    type: "key",
                    label: "API key",
                    form: [
                      { key: "apiKey", type: "string", required: true, minLength: 10 },
                      { key: "region", type: "string", options: [{ value: "eu", label: "Europe" }] },
                    ],
                  },
                  { id: "device", type: "oauth", label: "Sign in" },
                  { id: "cli", type: "command", label: "CLI", command: ["login"] },
                ],
                connections: [
                  { type: "credential", id: "cred-1", label: "Work", method: "key", active: true },
                ],
              },
            ],
          }),
        },
      }),
    )

    const [provider] = await backend.listProviders()
    expect(provider).toMatchObject({ id: "cloud", name: "Cloud", connected: true })
    expect(provider?.connections).toEqual([
      { id: "cred-1", label: "Work", method: "key", active: true },
    ])
    expect(provider?.methods).toMatchObject([
      {
        id: "key",
        type: "key",
        form: [
          { key: "apiKey", type: "string", secret: true, minLength: 10 },
          { key: "region", type: "string", secret: false, options: [{ value: "eu", label: "Europe" }] },
        ],
      },
      { id: "device", type: "oauth" },
      { id: "cli", type: "command" },
    ])
  })

  it("starts an OAuth attempt, maps its status and cancels it", async () => {
    const connect = vi.fn(async () => ({
      data: {
        attemptID: "attempt-1",
        url: "https://example.invalid/auth",
        instructions: "Approve access",
        mode: "auto",
        time: { created: 1, expires: 60 },
      },
    }))
    const status = vi.fn(async () => ({ data: { status: "complete" } }))
    const cancel = vi.fn(async () => undefined)
    const backend = liveBackend(
      liveClient({
        integration: { oauth: { connect, status, cancel } },
      }),
    )

    expect(
      await backend.startProviderOAuth({ providerID: "cloud", methodID: "device" }),
    ).toEqual({
      id: "attempt-1",
      url: "https://example.invalid/auth",
      instructions: "Approve access",
      code: null,
      needsCode: false,
      expires: 60,
    })
    expect(
      await backend.providerOAuthStatus({ providerID: "cloud", attemptID: "attempt-1" }),
    ).toBe("complete")
    await backend.cancelProviderOAuth({ providerID: "cloud", attemptID: "attempt-1" })
    expect(connect).toHaveBeenCalledWith({ integrationID: "cloud", methodID: "device", answer: undefined, label: undefined })
    expect(cancel).toHaveBeenCalledWith({ integrationID: "cloud", attemptID: "attempt-1" })
  })

  it("forwards the key once and reads the host default", async () => {
    const key = vi.fn(async () => undefined)
    const backend = liveBackend(
      liveClient({
        integration: { connect: { key } },
        model: {
          default: async () => ({
            data: { modelID: "gpt-x", name: "GPT X", providerID: "openai" },
          }),
        },
      }),
    )

    await backend.connectProviderKey({
      providerID: "cloud",
      methodID: "key",
      key: "secret-value",
      answer: { region: "eu" },
    })
    expect(key).toHaveBeenCalledWith({
      integrationID: "cloud",
      key: "secret-value",
      answer: { region: "eu" },
      label: undefined,
    })
    expect(await backend.hostDefaultModel()).toEqual(
      expect.objectContaining({
        id: "gpt-x",
        name: "GPT X",
        providerID: "openai",
        default: true,
      }),
    )
  })

  it("applies a known model and agent when the live session is created", async () => {
    const create = vi.fn(async () => ({
      id: "ses_1",
      title: "",
      directory: "/workspace",
      time: { created: 1, updated: 1 },
    }))
    const backend = liveBackend(
      liveClient({
        model: {
          list: async () => ({
            data: [{ modelID: "gpt-x", name: "GPT X", providerID: "openai" }],
          }),
        },
        session: { create },
      }),
    )
    await backend.listModels()
    await backend.createSession({
      directory: "/workspace",
      model: "gpt-x",
      agent: "build",
    })
    expect(create).toHaveBeenCalledWith({
      location: { directory: "/workspace" },
      title: null,
      model: { id: "gpt-x", providerID: "openai" },
      agent: "build",
    })
  })
})
