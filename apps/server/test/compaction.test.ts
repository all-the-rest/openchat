import { describe, expect, it, vi } from "vitest"
import { EVENT } from "@openchat/contracts"
import type { Message, PromptResponse, SessionInfo, TurnPolicy } from "@openchat/contracts"
import { BackendError } from "@openchat/opencode"
import { ContextSoftCap } from "../src/context-cap"
import { json, login, makeConfig, makeServer, openEvents } from "./helpers"
import type { TestServer } from "./helpers"

async function createSession(server: TestServer, cookie: string): Promise<SessionInfo> {
  const response = await server.app.request("/api/sessions", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  })
  return json<SessionInfo>(response)
}

async function prompt(
  server: TestServer,
  cookie: string,
  sessionID: string,
  text: string,
  delivery?: "queue",
): Promise<PromptResponse> {
  const response = await server.app.request(`/api/sessions/${sessionID}/prompt`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(delivery ? { text, delivery } : { text }),
  })
  expect(response.status).toBe(200)
  return json<PromptResponse>(response)
}

async function waitComplete(server: TestServer, sessionID: string): Promise<Message[]> {
  const deadline = Date.now() + 2_000
  while (Date.now() <= deadline) {
    const messages = await server.backend.listMessages(sessionID)
    const assistant = messages.filter((message) => message.role === "assistant").at(-1)
    if (assistant && assistant.status !== "streaming") return messages
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("Timed out waiting for the fake run")
}

const CAP_ENV = { CHAT_CONTEXT_SOFT_CAP: "1000" }

describe("context soft cap config", () => {
  it("defaults to 200k and accepts 0 as off", () => {
    expect(makeConfig().CHAT_CONTEXT_SOFT_CAP).toBe(200_000)
    expect(makeConfig({ CHAT_CONTEXT_SOFT_CAP: "0" }).CHAT_CONTEXT_SOFT_CAP).toBe(0)
    expect(makeConfig({ CHAT_CONTEXT_SOFT_CAP: "500000" }).CHAT_CONTEXT_SOFT_CAP).toBe(500_000)
  })

  it("falls back to the default for a negative or non-integer value", () => {
    expect(makeConfig({ CHAT_CONTEXT_SOFT_CAP: "-1" }).CHAT_CONTEXT_SOFT_CAP).toBe(200_000)
    expect(makeConfig({ CHAT_CONTEXT_SOFT_CAP: "1.5" }).CHAT_CONTEXT_SOFT_CAP).toBe(200_000)
  })
})

describe("prompt admission with the soft cap", () => {
  it("does not compact below the cap and still sends the prompt", async () => {
    const server = makeServer({ env: { CHAT_CONTEXT_SOFT_CAP: "2000" }, usageTokens: 1000 })
    const cookie = await login(server)
    const session = await createSession(server, cookie)
    await prompt(server, cookie, session.id, "first")
    await waitComplete(server, session.id)

    const second = await prompt(server, cookie, session.id, "second")
    expect(second.notices).toBeUndefined()
    expect(server.backend.compactionRecord(session.id).count).toBe(0)
    const messages = await waitComplete(server, session.id)
    expect(messages.some((message) => message.role === "user" && message.parts[0]?.type === "text" && message.parts[0].text === "second")).toBe(true)
  })

  it("compacts once at the cap, notices it and lets the prompt through", async () => {
    const server = makeServer({ env: CAP_ENV, usageTokens: 1000 })
    const cookie = await login(server)
    const session = await createSession(server, cookie)
    await prompt(server, cookie, session.id, "first")
    await waitComplete(server, session.id)

    const second = await prompt(server, cookie, session.id, "second")
    expect(second.notices).toEqual(["contextCompacted"])
    expect(server.backend.compactionRecord(session.id)).toMatchObject({
      count: 1,
      failures: 0,
      lastReason: "auto",
    })
    await waitComplete(server, session.id)
  })

  it("does not compact twice for the same reported usage", async () => {
    const server = makeServer({ env: CAP_ENV, usageTokens: 1000 })
    const cookie = await login(server)
    const session = await createSession(server, cookie)
    await prompt(server, cookie, session.id, "first")
    await waitComplete(server, session.id)
    await prompt(server, cookie, session.id, "second")
    await waitComplete(server, session.id)

    const third = await prompt(server, cookie, session.id, "third")
    expect(third.notices).toBeUndefined()
    expect(server.backend.compactionRecord(session.id).count).toBe(1)
  })

  it("never compacts while the session is streaming", async () => {
    const server = makeServer({ env: CAP_ENV, delayMs: 150, usageTokens: 1000 })
    const cookie = await login(server)
    const session = await createSession(server, cookie)
    await prompt(server, cookie, session.id, "first")
    server.backend.setContextUsage(session.id, 5000)

    const queued = await prompt(server, cookie, session.id, "second", "queue")
    expect(queued.queued).toBe(true)
    expect(queued.notices).toBeUndefined()
    expect(server.backend.compactionRecord(session.id).count).toBe(0)
    await server.backend.interrupt(session.id)
  })

  it("warns on a failed compaction but still sends the prompt", async () => {
    const server = makeServer({ env: CAP_ENV, usageTokens: 1000 })
    const cookie = await login(server)
    const session = await createSession(server, cookie)
    await prompt(server, cookie, session.id, "first")
    await waitComplete(server, session.id)
    server.backend.failNextCompaction(session.id)

    const second = await prompt(server, cookie, session.id, "second")
    expect(second.notices).toEqual(["contextCompactionFailed"])
    expect(server.backend.compactionRecord(session.id)).toMatchObject({
      count: 1,
      failures: 1,
    })
    const messages = await waitComplete(server, session.id)
    expect(messages.some((message) => message.role === "user")).toBe(true)
  })

  it("leaves compaction to the host when the cap is 0", async () => {
    const server = makeServer({ env: { CHAT_CONTEXT_SOFT_CAP: "0" }, usageTokens: 1000 })
    const cookie = await login(server)
    const session = await createSession(server, cookie)
    await prompt(server, cookie, session.id, "first")
    await waitComplete(server, session.id)

    const second = await prompt(server, cookie, session.id, "second")
    expect(second.notices).toBeUndefined()
    expect(server.backend.compactionRecord(session.id).count).toBe(0)
  })

  it("admits below the policy cap even when the environment value is lower", async () => {
    const server = makeServer({
      env: { CHAT_CONTEXT_SOFT_CAP: "1000" },
      usageTokens: 1000,
      chatPolicy: chatPolicy(5000),
    })
    const cookie = await login(server)
    const session = await createSession(server, cookie)
    await prompt(server, cookie, session.id, "first")
    await waitComplete(server, session.id)

    const second = await prompt(server, cookie, session.id, "second")
    expect(second.notices).toBeUndefined()
    expect(server.backend.compactionRecord(session.id).count).toBe(0)
  })

  it("compacts at the policy cap even when the environment value is higher", async () => {
    const server = makeServer({
      env: { CHAT_CONTEXT_SOFT_CAP: "500000" },
      usageTokens: 1000,
      chatPolicy: chatPolicy(1000),
    })
    const cookie = await login(server)
    const session = await createSession(server, cookie)
    await prompt(server, cookie, session.id, "first")
    await waitComplete(server, session.id)

    const second = await prompt(server, cookie, session.id, "second")
    expect(second.notices).toEqual(["contextCompacted"])
    expect(server.backend.compactionRecord(session.id).count).toBe(1)
    await waitComplete(server, session.id)
  })
})

function chatPolicy(contextSoftCap: number): TurnPolicy {
  return { surface: "chat", chain: [], paidDailyTurns: 0, contextSoftCap }
}

describe("context soft cap bookkeeping", () => {
  function capBackend(used: number) {
    const compacted: string[] = []
    return {
      compacted,
      sessionContext: async () => ({
        usage: { input: used, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        streaming: false,
      }),
      compact: async (sessionID: string) => {
        compacted.push(sessionID)
        return { status: "ended" as const }
      },
    }
  }

  it("keeps the last-attempt map bounded and evicts the oldest session", async () => {
    const backend = capBackend(5000)
    const softCap = new ContextSoftCap({ backend, cap: 1000, waitMs: 1 })
    for (let index = 0; index < 513; index += 1) {
      expect((await softCap.admit(`s${index}`)).reason).toBe("ended")
    }

    expect(softCap.trackedCount()).toBe(512)
    // The oldest level was evicted, so that session may compact again; the
    // newest one is still remembered and reports the same level as a repeat.
    const before = backend.compacted.length
    expect((await softCap.admit("s0")).reason).toBe("ended")
    expect(backend.compacted.length).toBe(before + 1)
    expect((await softCap.admit("s512")).reason).toBe("repeat")
  })

  it("makes each attempt's compaction id unique across attempts and a simulated restart", async () => {
    const ids: string[] = []
    const backend = {
      sessionContext: async () => ({
        usage: { input: 5000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        streaming: false,
      }),
      compact: async (_sessionID: string, options?: { id?: string }) => {
        if (options?.id !== undefined) ids.push(options.id)
        return { status: "failed" as const }
      },
    }

    const beforeRestart = new ContextSoftCap({ backend, cap: 1000, waitMs: 1 })
    expect((await beforeRestart.admit("s1")).reason).toBe("failed")
    // The same level inside one process is still deduped: no second attempt.
    expect((await beforeRestart.admit("s1")).reason).toBe("repeat")

    // A fresh instance stands in for a BFF restart; its map is empty, so the
    // same usage level attempts again and must not re-use the host id.
    const afterRestart = new ContextSoftCap({ backend, cap: 1000, waitMs: 1 })
    expect((await afterRestart.admit("s1")).reason).toBe("failed")

    expect(ids).toHaveLength(2)
    expect(ids[0]).toMatch(/^msg_softcap_s1_5000_/)
    expect(ids[1]).toMatch(/^msg_softcap_s1_5000_/)
    expect(ids[1]).not.toBe(ids[0])
  })
})

describe("manual compaction route", () => {
  it("requires authentication", async () => {
    const server = makeServer()
    const response = await server.app.request("/api/sessions/ses_1/compact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(response.status).toBe(401)
  })

  it("compacts on request and emits started and ended", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const session = await createSession(server, cookie)
    const stream = await openEvents(server, cookie)

    const response = await server.app.request(`/api/sessions/${session.id}/compact`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    })
    expect(response.status).toBe(200)
    expect(await json(response)).toMatchObject({ ok: true, status: "accepted" })
    await stream.waitFor((event) => event.type === EVENT.compactionStarted)
    const ended = await stream.waitFor((event) => event.type === EVENT.compactionEnded)
    expect(ended.data.text).toEqual(expect.any(String))
    expect(server.backend.compactionRecord(session.id)).toMatchObject({
      count: 1,
      lastReason: "manual",
    })
    await stream.close()
  })

  it("compacts once for a repeated idempotency key", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const session = await createSession(server, cookie)
    const body = JSON.stringify({ id: "msg_compact_test" })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await server.app.request(`/api/sessions/${session.id}/compact`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body,
      })
      expect(response.status).toBe(200)
    }
    expect(server.backend.compactionRecord(session.id).count).toBe(1)
  })

  it("rejects an idempotency key without the host prefix", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const session = await createSession(server, cookie)

    const response = await server.app.request(`/api/sessions/${session.id}/compact`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id: "soft-cap:2" }),
    })
    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({ error: { code: "invalid_request" } })
    expect(server.backend.compactionRecord(session.id).count).toBe(0)
  })

  it("rejects a streaming session with 409", async () => {
    const server = makeServer({ delayMs: 150 })
    const cookie = await login(server)
    const session = await createSession(server, cookie)
    await prompt(server, cookie, session.id, "first")

    const response = await server.app.request(`/api/sessions/${session.id}/compact`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    })
    expect(response.status).toBe(409)
    expect(await json(response)).toMatchObject({ error: { code: "conflict" } })
    await server.backend.interrupt(session.id)
  })

  it("maps an unknown session to 404", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const response = await server.app.request("/api/sessions/ses_missing/compact", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    })
    expect(response.status).toBe(404)
    expect(await json(response)).toMatchObject({ error: { code: "not_found" } })
  })

  it("maps a host failure without forwarding its message", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const session = await createSession(server, cookie)
    vi.spyOn(server.backend, "compact").mockRejectedValue(
      new BackendError("unavailable", "The host did not answer the compaction request"),
    )
    const response = await server.app.request(`/api/sessions/${session.id}/compact`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    })
    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({ error: { code: "unavailable" } })
  })
})
