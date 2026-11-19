import { describe, expect, it, vi } from "vitest"
import type { ProviderInfo } from "@openchat/contracts"
import { FixedWindowThrottle } from "../src/throttle"
import { json, login, makeServer } from "./helpers"

const KEY = "test-api-key-123"

async function providers(server: ReturnType<typeof makeServer>, cookie: string): Promise<ProviderInfo[]> {
  const response = await server.app.request("/api/providers", { headers: { cookie } })
  expect(response.status).toBe(200)
  return json<ProviderInfo[]>(response)
}

async function connect(
  server: ReturnType<typeof makeServer>,
  cookie: string,
  body: Record<string, unknown>,
) {
  return server.app.request("/api/providers/fake-cloud/connect/key", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("provider catalogue", () => {
  it("maps the host inventory to methods, forms and connection state", async () => {
    const server = makeServer({ seedModels: false })
    const cookie = await login(server)

    const [provider] = await providers(server, cookie)
    expect(provider).toMatchObject({
      id: "fake-cloud",
      name: "Fake Cloud",
      connected: false,
      connections: [],
    })
    expect(provider?.methods.map((method) => method.type)).toEqual(["key", "oauth", "command"])
    const key = provider?.methods.find((method) => method.type === "key")
    const secret = key?.form.find((field) => field.secret)
    expect(secret).toMatchObject({ key: "key", type: "string", minLength: 8 })
    const region = key?.form.find((field) => field.key === "region")
    expect(region?.options?.map((option) => option.value)).toEqual(["eu", "us"])
  })

  it("requires authentication", async () => {
    const server = makeServer()
    const response = await server.app.request("/api/providers")
    expect(response.status).toBe(401)
  })

  it("answers stable codes when the host cannot be read", async () => {
    const server = makeServer()
    const cookie = await login(server)
    server.backend.listProviders = async () => {
      throw new Error("upstream detail that must not leak")
    }
    const catalogue = await server.app.request("/api/providers", { headers: { cookie } })
    expect(catalogue.status).toBe(502)
    const catalogueBody = await catalogue.text()
    expect(catalogueBody).toContain("providers_unavailable")
    expect(catalogueBody).not.toContain("upstream detail")

    server.backend.listModels = async () => {
      throw new Error("upstream detail that must not leak")
    }
    const status = await server.app.request("/api/providers/status", { headers: { cookie } })
    expect(status.status).toBe(502)
    const statusBody = await status.text()
    expect(statusBody).toContain("provider_models_unavailable")
    expect(statusBody).not.toContain("upstream detail")
  })
})

describe("key connection", () => {
  it("stores the key without echoing it in the response or a log line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const server = makeServer({ seedModels: false })
    const cookie = await login(server)

    const response = await connect(server, cookie, {
      methodID: "api-key",
      key: KEY,
      answer: { region: "eu" },
    })
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).not.toContain(KEY)
    expect(JSON.parse(body)).toEqual({ ok: true })
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()

    // The fake stores metadata only; its probe cannot leak the value either.
    const recorded = await server.app.request("/api/__fake/providers", { headers: { cookie } })
    const record = await recorded.text()
    expect(record).not.toContain(KEY)
    expect(JSON.parse(record)).toMatchObject({
      connects: [{ providerID: "fake-cloud", methodID: "api-key", keyLength: KEY.length }],
    })

    const [provider] = await providers(server, cookie)
    expect(provider?.connected).toBe(true)
    expect(provider?.connections[0]).toMatchObject({ method: "key", active: true })
  })

  it("rejects a value that violates the declared form and stays disconnected", async () => {
    const server = makeServer({ seedModels: false })
    const cookie = await login(server)

    const response = await connect(server, cookie, {
      methodID: "api-key",
      key: "short",
      answer: { region: "eu" },
    })
    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({
      error: { code: "provider_form_invalid" },
    })
    expect((await providers(server, cookie))[0]?.connected).toBe(false)
    expect(server.backend.recordedProviders().connects).toEqual([])
  })

  it("rejects a field the form does not declare", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const response = await connect(server, cookie, {
      methodID: "api-key",
      key: KEY,
      answer: { region: "eu", admin: true },
    })
    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({ error: { code: "provider_form_invalid" } })
  })

  it("does not drive a host-only command method through the key route", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const response = await connect(server, cookie, { methodID: "cli", key: KEY })
    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({
      error: { code: "provider_method_unsupported" },
    })
  })

  it("reports the model catalogue after a connection", async () => {
    const server = makeServer({ seedModels: false })
    const cookie = await login(server)
    expect(
      await (await server.app.request("/api/providers/status", { headers: { cookie } })).json(),
    ).toEqual({ models: [] })

    const connected = await connect(server, cookie, {
      methodID: "api-key",
      key: KEY,
      answer: { region: "eu" },
    })
    expect(connected.status).toBe(200)

    const status = await server.app.request("/api/providers/status", { headers: { cookie } })
    expect(await json(status)).toEqual({
      models: [
        expect.objectContaining({
          id: "fake/echo",
          name: "Fake Echo",
          providerID: "fake",
          variants: ["fast", "thorough"],
          status: "active",
        }),
      ],
    })
  })

  it("throttles connect attempts per address", async () => {
    const server = makeServer({
      seedModels: false,
      providerConnectThrottle: new FixedWindowThrottle({ limit: 1, windowMs: 60_000 }),
    })
    const cookie = await login(server)

    const first = await connect(server, cookie, { methodID: "api-key", key: "short" })
    expect(first.status).toBe(400)
    const second = await connect(server, cookie, {
      methodID: "api-key",
      key: KEY,
      answer: { region: "eu" },
    })
    expect(second.status).toBe(429)
    expect(second.headers.get("retry-after")).toBe("60")
    expect(server.backend.recordedProviders().connects).toEqual([])
  })
})

describe("oauth connection", () => {
  it("starts, polls a pending attempt and completes when the host says so", async () => {
    let now = 1_000
    const server = makeServer({ seedModels: false, now: () => now, oauthDelayMs: 5_000 })
    const cookie = await login(server)

    const started = await server.app.request("/api/providers/fake-cloud/connect/oauth", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ methodID: "browser", answer: { workspace: "team-one" } }),
    })
    expect(started.status).toBe(200)
    const { attempt } = await json<{ attempt: { id: string; url: string } }>(started)
    expect(attempt.url).toContain("example.invalid")

    const pending = await server.app.request(
      `/api/providers/fake-cloud/connect/oauth/${attempt.id}`,
      { headers: { cookie } },
    )
    expect(await json(pending)).toEqual({ status: "pending" })

    now += 5_000
    const complete = await server.app.request(
      `/api/providers/fake-cloud/connect/oauth/${attempt.id}`,
      { headers: { cookie } },
    )
    expect(await json(complete)).toEqual({ status: "complete" })

    const status = await server.app.request("/api/providers/status", { headers: { cookie } })
    expect(await json(status)).toMatchObject({ models: [{ id: "fake/echo" }] })
    expect(server.backend.recordedProviders()).toMatchObject({ oauthStarts: 1, oauthCancels: 0 })
  })

  it("validates the declared OAuth form", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const response = await server.app.request("/api/providers/fake-cloud/connect/oauth", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ methodID: "browser", answer: { workspace: "Bad Slug" } }),
    })
    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({ error: { code: "provider_form_invalid" } })
  })

  it("cancels an attempt and hides it afterwards", async () => {
    const server = makeServer({ oauthDelayMs: 60_000 })
    const cookie = await login(server)

    const started = await server.app.request("/api/providers/fake-cloud/connect/oauth", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ methodID: "browser" }),
    })
    const { attempt } = await json<{ attempt: { id: string } }>(started)
    const path = `/api/providers/fake-cloud/connect/oauth/${attempt.id}`

    const cancelled = await server.app.request(path, {
      method: "DELETE",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    })
    expect(cancelled.status).toBe(204)
    expect(server.backend.recordedProviders()).toMatchObject({ oauthStarts: 1, oauthCancels: 1 })

    const after = await server.app.request(path, { headers: { cookie } })
    expect(after.status).toBe(404)
    expect(await json(after)).toMatchObject({ error: { code: "provider_attempt_unknown" } })
  })
})

describe("new-session default", () => {
  it("carries the browser choice from the create request to the host", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const response = await server.app.request("/api/sessions", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ model: "fake/echo", agent: "build" }),
    })
    expect(response.status).toBe(200)
    const session = await json<{ id: string }>(response)
    expect(server.backend.sessionCompletion(session.id)).toEqual({
      model: "fake/echo",
      agent: "build",
    })
  })
})

describe("host default model", () => {
  it("is exposed as a read-only value", async () => {
    const server = makeServer()
    const cookie = await login(server)
    const response = await server.app.request("/api/models/default", { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({
      model: expect.objectContaining({
        id: "fake/echo",
        name: "Fake Echo",
        providerID: "fake",
        variants: ["fast", "thorough"],
        status: "active",
      }),
    })
  })

  it("reports no default before a provider yields a model", async () => {
    const server = makeServer({ seedModels: false })
    const cookie = await login(server)
    const response = await server.app.request("/api/models/default", { headers: { cookie } })
    expect(await json(response)).toEqual({ model: null })
  })
})
