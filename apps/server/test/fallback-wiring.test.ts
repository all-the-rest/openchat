import { describe, expect, it, vi } from "vitest"
import { EVENT } from "@openchat/contracts"
import type { TurnPolicy } from "@openchat/contracts"
import { createApp } from "../src/app"
import type { FallbackEngine } from "../src/fallback-engine"
import { json, login, makeConfig, openEvents } from "./helpers"

function twoModelPolicy(): TurnPolicy {
  return {
    surface: "chat",
    chain: [
      { providerID: "free", modelID: "glm", isFree: true },
      { providerID: "paid", modelID: "gpt" },
    ],
    paidDailyCap: 10,
    contextSoftCap: 0,
  }
}

async function createSession(app: ReturnType<typeof createApp>, cookie: string) {
  const res = await app.request("/api/sessions", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ title: "Fallback wiring" }),
  })
  return json<{ id: string }>(res)
}

function prompt(app: ReturnType<typeof createApp>, cookie: string, sessionID: string, text: string) {
  return app.request(`/api/sessions/${sessionID}/prompt`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  })
}

/** A fake engine that records calls but never actually retries. */
function recordingEngine() {
  const observe = vi.fn()
  const begin = vi.fn()
  const onFailure = vi.fn(async () => ({ suppress: false, events: [] }))
  const onSuccess = vi.fn(async () => [])
  const engine = { observe, begin, onFailure, onSuccess } as unknown as FallbackEngine
  return { engine, observe, begin, onFailure, onSuccess }
}

describe("fallback wiring", () => {
  it("passes the resolved first model into prompt and registers a turn", async () => {
    const config = makeConfig()
    const { FakeBackend } = await import("@openchat/opencode")
    const { engine, begin } = recordingEngine()
    const app = createApp({ config, backend: new FakeBackend({ workspace: config.WORKSPACE_DIR }), fallback: engine, chatPolicy: twoModelPolicy() })
    const cookie = await login({ app, backend: new FakeBackend(), config })
    const { id } = await createSession(app, cookie)

    const res = await prompt(app, cookie, id, "hello")
    expect(res.status).toBe(200)
    expect(begin).toHaveBeenCalledTimes(1)
    const [sessionID, payload, policy, requested] = begin.mock.calls[0] as unknown as [string, Record<string, unknown>, TurnPolicy, { modelID: string }]
    expect(sessionID).toBe(id)
    expect(payload.modelRef).toEqual({ providerID: "free", modelID: "glm", isFree: true })
    expect(policy.surface).toBe("chat")
    expect(requested.modelID).toBe("glm")
  })

  it("observes events and consults the engine on failure and success", async () => {
    const config = makeConfig()
    const { FakeBackend } = await import("@openchat/opencode")
    const backend = new FakeBackend({ workspace: config.WORKSPACE_DIR })
    const { engine, observe, onFailure, onSuccess } = recordingEngine()
    const app = createApp({ config, backend, fallback: engine, chatPolicy: twoModelPolicy() })
    const cookie = await login({ app, backend, config })
    const { id } = await createSession(app, cookie)

    const events = await openEvents({ app, backend, config }, cookie)
    await prompt(app, cookie, id, "hello")
    await events.waitFor((event) => event.type === EVENT.executionSucceeded)
    expect(observe).toHaveBeenCalled()
    expect(onSuccess).toHaveBeenCalled()
    expect(onFailure).not.toHaveBeenCalled()
    await events.close()
  })

  it("forwards synthetic events when the engine suppresses a failure", async () => {
    const config = makeConfig()
    const { FakeBackend } = await import("@openchat/opencode")
    const backend = new FakeBackend({ workspace: config.WORKSPACE_DIR })
    const engine = {
      observe: vi.fn(),
      begin: vi.fn(),
      onFailure: vi.fn(async () => ({
        suppress: true,
        events: [
          { id: "notice-1", created: 1, type: EVENT.fallbackNotice, data: { sessionID: "s", to: { providerID: "paid", modelID: "gpt" }, attempts: 1 } },
        ],
      })),
      onSuccess: vi.fn(async () => []),
    } as unknown as FallbackEngine
    const app = createApp({ config, backend, fallback: engine, chatPolicy: twoModelPolicy() })
    const cookie = await login({ app, backend, config })
    const events = await openEvents({ app, backend, config }, cookie)
    // Drive the engine through a bare failure event via the fake `fallback:` prefix.
    const { id } = await createSession(app, cookie)
    await prompt(app, cookie, id, "fallback: this failed")
    const notice = await events.waitFor((event) => event.type === EVENT.fallbackNotice)
    expect(notice.data.to).toMatchObject({ modelID: "gpt" })
    await events.close()
  })
})
