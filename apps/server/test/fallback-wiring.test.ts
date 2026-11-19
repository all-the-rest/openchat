import { describe, expect, it, vi } from "vitest"
import { EVENT } from "@openchat/contracts"
import type { Message, TurnPolicy } from "@openchat/contracts"
import { FakeBackend } from "@openchat/opencode"
import type { PromptInput, PromptResult } from "@openchat/opencode"
import { createApp } from "../src/app"
import type { FallbackEngine } from "../src/fallback-engine"
import { FallbackEngine as RealFallbackEngine } from "../src/fallback-engine"
import { json, login, makeConfig, openEvents } from "./helpers"

function twoModelPolicy(): TurnPolicy {
  return {
    surface: "chat",
    chain: [
      { providerID: "free", modelID: "glm", isFree: true },
      { providerID: "paid", modelID: "gpt" },
    ],
    paidDailyTurns: 10,
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

function prompt(
  app: ReturnType<typeof createApp>,
  cookie: string,
  sessionID: string,
  body: Record<string, unknown>,
) {
  return app.request(`/api/sessions/${sessionID}/prompt`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function messages(
  app: ReturnType<typeof createApp>,
  cookie: string,
  sessionID: string,
): Promise<Message[]> {
  const res = await app.request(`/api/sessions/${sessionID}/messages`, { headers: { cookie } })
  return json<Message[]>(res)
}

function textOf(message: Message): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
}

/** A fake engine that records calls but never actually retries. */
function recordingEngine() {
  const observe = vi.fn()
  const begin = vi.fn()
  const adopt = vi.fn()
  const abandon = vi.fn()
  const forget = vi.fn()
  const onFailure = vi.fn(async () => ({ suppress: false, events: [] }))
  const onSuccess = vi.fn(async () => [])
  const engine = {
    observe,
    begin,
    adopt,
    abandon,
    forget,
    onFailure,
    onSuccess,
    activeCount: () => 0,
  } as unknown as FallbackEngine
  return { engine, observe, begin, adopt, abandon, forget, onFailure, onSuccess }
}

/**
 * The fake backend, but the first prompt's HTTP response resolves after the
 * run already streamed its first delta. That is the window in which a late
 * registration would lose the text.
 */
class LateResponseBackend extends FakeBackend {
  calls = 0

  override async prompt(sessionID: string, input: PromptInput): Promise<PromptResult> {
    const result = await super.prompt(sessionID, input)
    this.calls += 1
    if (this.calls === 1) await new Promise((resolve) => setTimeout(resolve, 5))
    return result
  }
}

function realEngine(backend: FakeBackend) {
  const record = vi.fn(async () => {})
  const paidTurnsToday = vi.fn(async () => 0)
  const engine = new RealFallbackEngine({ backend, ledger: { record, paidTurnsToday } })
  return { engine, record, paidTurnsToday }
}

describe("fallback wiring", () => {
  it("passes the resolved first model into prompt and registers a turn", async () => {
    const config = makeConfig()
    const backend = new FakeBackend({ workspace: config.WORKSPACE_DIR })
    const { engine, begin, adopt } = recordingEngine()
    const app = createApp({ config, backend, fallback: engine, chatPolicy: twoModelPolicy() })
    const cookie = await login({ app, backend, config })
    const { id } = await createSession(app, cookie)

    const res = await prompt(app, cookie, id, { text: "hello" })
    expect(res.status).toBe(200)
    expect(begin).toHaveBeenCalledTimes(1)
    const [sessionID, payload, policy, requested] = begin.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      TurnPolicy,
      { modelID: string },
    ]
    expect(sessionID).toBe(id)
    expect(payload.modelRef).toEqual({ providerID: "free", modelID: "glm", isFree: true })
    expect(policy.surface).toBe("chat")
    expect(requested.modelID).toBe("glm")
    // The message id only exists after the response; it is adopted then.
    expect(adopt).toHaveBeenCalledWith(id, expect.stringContaining("msg"))
  })

  it("lets the client model win attempt 1 and keeps the chain as the tail", async () => {
    const config = makeConfig()
    const backend = new FakeBackend({ workspace: config.WORKSPACE_DIR })
    const { engine, begin } = recordingEngine()
    const app = createApp({ config, backend, fallback: engine, chatPolicy: twoModelPolicy() })
    const cookie = await login({ app, backend, config })
    const { id } = await createSession(app, cookie)

    // The browser sends a host model id. `fake/legacy` contains a slash but is
    // not a `providerID/modelID` pair, so the catalogue must resolve it.
    await prompt(app, cookie, id, {
      text: "hello",
      model: "fake/legacy",
      variant: "deep",
    })

    const [, payload, , requested] = begin.mock.calls[0] as unknown as [
      string,
      { modelRef?: unknown },
      TurnPolicy,
      unknown,
    ]
    const clientRef = { providerID: "fake", modelID: "fake/legacy", contextLimit: 8_000 }
    expect(payload.modelRef).toEqual(clientRef)
    expect(requested).toEqual(clientRef)

    // A chain model id needs no catalogue read and keeps its free/window data.
    const second = await createSession(app, cookie)
    await prompt(app, cookie, second.id, { text: "hello", model: "glm" })
    const [, secondPayload] = begin.mock.calls[1] as unknown as [
      string,
      { modelRef?: unknown },
    ]
    expect(secondPayload.modelRef).toEqual({
      providerID: "free",
      modelID: "glm",
      isFree: true,
    })
  })

  it("re-prompts on the chain's first entry after a client-model turn", async () => {
    const config = makeConfig()
    const backend = new FakeBackend({ workspace: config.WORKSPACE_DIR })
    const { engine, record } = realEngine(backend)
    const app = createApp({ config, backend, fallback: engine, chatPolicy: twoModelPolicy() })
    const cookie = await login({ app, backend, config })
    const { id } = await createSession(app, cookie)
    const events = await openEvents({ app, backend, config }, cookie)

    await prompt(app, cookie, id, { text: "fallback: hello", model: "echo/prime", variant: "high" })
    const notice = await events.waitFor((event) => event.type === EVENT.fallbackNotice)
    expect(notice.data.from).toEqual({
      providerID: "echo",
      modelID: "echo/prime",
      variant: "high",
      contextLimit: 200_000,
    })
    expect(notice.data.to).toEqual({ providerID: "free", modelID: "glm", isFree: true })

    const outcome = await events.waitFor((event) => event.type === EVENT.turnOutcome)
    expect(outcome.data).toMatchObject({
      requested: {
        providerID: "echo",
        modelID: "echo/prime",
        variant: "high",
      },
      answered: { providerID: "free", modelID: "glm" },
      attempts: 2,
    })
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ providerID: "free", modelID: "glm", isFree: true }),
    )
    await events.close()

    // The host appends a user message per prompt, so a retry leaves the failed
    // attempt and its identical user message in the history. Nothing is
    // rewritten or deleted.
    const history = await messages(app, cookie, id)
    expect(history.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ])
    expect(textOf(history[0]!)).toBe("fallback: hello")
    expect(textOf(history[2]!)).toBe("fallback: hello")
    expect(history[1]?.status).toBe("error")
    expect(history[3]?.status).toBe("complete")
  })

  it("does not retry after text arrives before the prompt response resolves", async () => {
    const config = makeConfig()
    const backend = new LateResponseBackend({ workspace: config.WORKSPACE_DIR })
    const { engine, record } = realEngine(backend)
    const app = createApp({ config, backend, fallback: engine, chatPolicy: twoModelPolicy() })
    const cookie = await login({ app, backend, config })
    const { id } = await createSession(app, cookie)
    const events = await openEvents({ app, backend, config }, cookie)

    const res = await prompt(app, cookie, id, { text: "fallback-text: hello" })
    expect(res.status).toBe(200)
    await events.waitFor((event) => event.type === EVENT.executionFailed)
    // One prompt only: the text that arrived while the POST was open blocked
    // the retry, because the turn was registered before submitting.
    expect(backend.calls).toBe(1)
    expect(events.events.some((event) => event.type === EVENT.fallbackNotice)).toBe(false)
    expect(record).not.toHaveBeenCalled()
    await events.close()

    const history = await messages(app, cookie, id)
    expect(history.map((message) => message.role)).toEqual(["user", "assistant"])
  })

  it("abandons the registration when the submit itself fails", async () => {
    const config = makeConfig()
    const backend = new FakeBackend({ workspace: config.WORKSPACE_DIR })
    const { engine } = realEngine(backend)
    const app = createApp({ config, backend, fallback: engine, chatPolicy: twoModelPolicy() })
    const cookie = await login({ app, backend, config })

    const res = await prompt(app, cookie, "ses_missing", { text: "hello" })
    expect(res.status).toBe(404)
    expect(engine.activeCount()).toBe(0)
  })

  it("observes events and consults the engine on failure and success", async () => {
    const config = makeConfig()
    const backend = new FakeBackend({ workspace: config.WORKSPACE_DIR })
    const { engine, observe, onFailure, onSuccess } = recordingEngine()
    const app = createApp({ config, backend, fallback: engine, chatPolicy: twoModelPolicy() })
    const cookie = await login({ app, backend, config })
    const { id } = await createSession(app, cookie)

    const events = await openEvents({ app, backend, config }, cookie)
    await prompt(app, cookie, id, { text: "hello" })
    await events.waitFor((event) => event.type === EVENT.executionSucceeded)
    expect(observe).toHaveBeenCalled()
    expect(onSuccess).toHaveBeenCalled()
    expect(onFailure).not.toHaveBeenCalled()
    await events.close()
  })

  it("forwards synthetic events when the engine suppresses a failure", async () => {
    const config = makeConfig()
    const backend = new FakeBackend({ workspace: config.WORKSPACE_DIR })
    const engine = {
      observe: vi.fn(),
      begin: vi.fn(),
      adopt: vi.fn(),
      abandon: vi.fn(),
      forget: vi.fn(),
      onFailure: vi.fn(async () => ({
        suppress: true,
        events: [
          {
            id: "notice-1",
            created: 1,
            type: EVENT.fallbackNotice,
            data: {
              sessionID: "s",
              to: { providerID: "paid", modelID: "gpt" },
              attempts: 1,
            },
          },
        ],
      })),
      onSuccess: vi.fn(async () => []),
      activeCount: () => 0,
    } as unknown as FallbackEngine
    const app = createApp({ config, backend, fallback: engine, chatPolicy: twoModelPolicy() })
    const cookie = await login({ app, backend, config })
    const events = await openEvents({ app, backend, config }, cookie)
    // Drive the engine through a bare failure event via the fake `fallback:` prefix.
    const { id } = await createSession(app, cookie)
    await prompt(app, cookie, id, { text: "fallback: this failed" })
    const notice = await events.waitFor((event) => event.type === EVENT.fallbackNotice)
    expect(notice.data.to).toMatchObject({ modelID: "gpt" })
    await events.close()
  })

  it("drops a queued send and keeps the active turn tracked", async () => {
    const config = makeConfig()
    const backend = new FakeBackend({ workspace: config.WORKSPACE_DIR, delayMs: 25 })
    const { engine } = realEngine(backend)
    const adopt = vi.spyOn(engine, "adopt")
    const abandon = vi.spyOn(engine, "abandon")
    const app = createApp({ config, backend, fallback: engine, chatPolicy: twoModelPolicy() })
    const cookie = await login({ app, backend, config })
    const { id } = await createSession(app, cookie)

    await prompt(app, cookie, id, { text: "first" })
    const queued = await prompt(app, cookie, id, { text: "second" })
    expect(await json<{ queued?: boolean }>(queued)).toMatchObject({ queued: true })

    expect(adopt).toHaveBeenCalledTimes(1)
    expect(abandon).toHaveBeenCalledTimes(1)
    // The active turn stays registered: begin snapshotted it and abandon
    // restored it, so its own completion and failure are still observed.
    expect(engine.activeCount()).toBe(1)
  })

  it("keeps a Code-surface request out of the engine and the ledger", async () => {
    const config = makeConfig({
      CODE_HOST_ORIGIN: "http://code.example:8090",
      CODE_TICKET_SECRET: "test-code-ticket-secret",
    })
    const backend = new FakeBackend({ workspace: config.WORKSPACE_DIR })
    const { engine, record, paidTurnsToday } = realEngine(backend)
    const begin = vi.spyOn(engine, "begin")
    const observe = vi.spyOn(engine, "observe")
    const app = createApp({
      config,
      backend,
      fallback: engine,
      chatPolicy: twoModelPolicy(),
      codeProbe: async () => ({ reachable: false, version: undefined }),
    })
    const cookie = await login({ app, backend, config })

    const ticket = await app.request("/api/code/ticket", { headers: { cookie } })
    expect(ticket.status).toBe(200)
    const status = await app.request("/api/code/status", { headers: { cookie } })
    expect(status.status).toBe(200)

    expect(begin).not.toHaveBeenCalled()
    expect(observe).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
    expect(paidTurnsToday).not.toHaveBeenCalled()
    expect(engine.activeCount()).toBe(0)
  })

  it("warns once at boot about invalid chain JSON without logging the value", async () => {
    const config = makeConfig({ FALLBACK_CHAIN_JSON: '{"apiKey":"sk-live-123"}' })
    const backend = new FakeBackend({ workspace: config.WORKSPACE_DIR })
    const warn = vi.fn()
    createApp({ config, backend, warn })

    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0]?.[0] ?? "")
    expect(message).toContain("FALLBACK_CHAIN_JSON")
    expect(message).toContain("disabled")
    expect(message).not.toContain("sk-live-123")
  })

  it("does not warn when no chain is configured", async () => {
    const config = makeConfig()
    const backend = new FakeBackend({ workspace: config.WORKSPACE_DIR })
    const warn = vi.fn()
    createApp({ config, backend, warn })
    expect(warn).not.toHaveBeenCalled()
  })
})
