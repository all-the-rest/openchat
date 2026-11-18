import type { Hono } from "hono"
import type { EventEnvelope, FakeScenario, SearchSource } from "@openchat/contracts"
import { FakeBackend } from "@openchat/opencode"
import { createApp } from "../src/app"
import type { AppEnv } from "../src/app"
import type { CodeProbe } from "../src/code"
import type { AppsCache, AppsProbe } from "../src/apps-cache"
import { loadEnv } from "../src/env"
import type { EnvConfig } from "../src/env"
import type { FixedWindowThrottle } from "../src/throttle"

export interface TestServer {
  app: Hono<AppEnv>
  backend: FakeBackend
  config: EnvConfig
}

export interface TestServerOptions {
  scenario?: FakeScenario
  delayMs?: number
  env?: Record<string, string | undefined>
  sttTimeoutMs?: number
  sseHeartbeatMs?: number
  /** Sources the fake reports as unavailable. */
  disabledSources?: readonly SearchSource[]
  /** Sources whose fake query throws. */
  failingSources?: readonly SearchSource[]
  /** Overrides `FAKE_APPS`; false simulates a host without an app surface. */
  appsAvailable?: boolean
  /** Records connect/disconnect calls. */
  onAppAction?: (action: "connect" | "disconnect", name: string) => void
  /** Code host health probe; keeps tests off the network. */
  codeProbe?: CodeProbe
  codeStatusCacheMs?: number
  codeNow?: () => number
  codeTicketThrottle?: FixedWindowThrottle
  /** App surface probe; the default reads the fake backend. */
  appsProbe?: AppsProbe
  appsCache?: AppsCache
  appsCacheMs?: number
  appsNow?: () => number
  appsActionThrottle?: FixedWindowThrottle
  /** Artifact creation throttle; tests inject a clock-bound instance. */
  artifactsThrottle?: FixedWindowThrottle
  artifactsNow?: () => number
}

export function makeConfig(overrides: Record<string, string | undefined> = {}): EnvConfig {
  return loadEnv({
    source: {
      AUTH_MODE: "session",
      OPENCHAT_USER: "owner",
      OPENCHAT_PASSWORD: "secret-password",
      SESSION_SECRET: "test-secret-test-secret-test-secret",
      SESSION_TTL_SECONDS: "3600",
      WORKSPACE_DIR: "/workspace",
      BACKEND_MODE: "fake",
      FAKE_SCENARIO: "default",
      ...overrides,
    },
    warn: () => {},
  })
}

export function makeServer(options: TestServerOptions = {}): TestServer {
  const config = makeConfig(options.env)
  const backend = new FakeBackend({
    scenario: options.scenario ?? config.FAKE_SCENARIO,
    delayMs: options.delayMs ?? 0,
    workspace: config.WORKSPACE_DIR,
    disabledSources: options.disabledSources,
    failingSources: options.failingSources,
    appsAvailable: options.appsAvailable ?? config.FAKE_APPS,
    onAppAction: options.onAppAction,
  })
  return {
    app: createApp({
      config,
      backend,
      sttTimeoutMs: options.sttTimeoutMs,
      sseHeartbeatMs: options.sseHeartbeatMs,
      codeProbe: options.codeProbe,
      codeStatusCacheMs: options.codeStatusCacheMs,
      codeNow: options.codeNow,
      codeTicketThrottle: options.codeTicketThrottle,
      appsProbe: options.appsProbe,
      appsCache: options.appsCache,
      appsCacheMs: options.appsCacheMs,
      appsNow: options.appsNow,
      appsActionThrottle: options.appsActionThrottle,
      artifactsThrottle: options.artifactsThrottle,
      artifactsNow: options.artifactsNow,
    }),
    backend,
    config,
  }
}

export async function login(server: TestServer, password = "secret-password"): Promise<string> {
  const response = await server.app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  })
  if (response.status !== 200) throw new Error(`Login failed with ${response.status}`)
  const header = response.headers.get("set-cookie") ?? ""
  const cookie = header.split(";")[0]
  if (!cookie) throw new Error("Login returned no cookie")
  return cookie
}

export function basicHeader(user = "owner", password = "secret-password"): string {
  return `Basic ${btoa(`${user}:${password}`)}`
}

export interface SseClient {
  events: EventEnvelope[]
  /** Raw response text, including comment and retry frames. */
  rawText(): string
  /** Waits until an event matching the predicate has arrived. */
  waitFor(predicate: (event: EventEnvelope) => boolean): Promise<EventEnvelope>
  waitForCount(type: string, count: number): Promise<void>
  close(): Promise<void>
}

/**
 * Opens `/api/events` and collects parsed envelopes in the background. The
 * response body stays open until `close()` aborts it.
 */
export async function openEvents(
  server: TestServer,
  cookie: string,
): Promise<SseClient> {
  const abort = new AbortController()
  const response = await server.app.request("/api/events", {
    headers: { cookie },
    signal: abort.signal,
  })
  if (response.status !== 200) throw new Error(`SSE failed with ${response.status}`)
  const body = response.body
  if (!body) throw new Error("SSE response has no body")

  const reader = body.getReader()
  const decoder = new TextDecoder()
  const events: EventEnvelope[] = []
  let raw = ""
  let buffer = ""
  let closed = false

  const pump = (async () => {
    try {
      while (!closed) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        raw += chunk
        buffer += chunk
        let separator = buffer.indexOf("\n\n")
        while (separator >= 0) {
          const frame = buffer.slice(0, separator)
          buffer = buffer.slice(separator + 2)
          for (const line of frame.split("\n")) {
            if (line.startsWith("data: ")) {
              events.push(JSON.parse(line.slice("data: ".length)) as EventEnvelope)
            }
          }
          separator = buffer.indexOf("\n\n")
        }
      }
    } catch {
      // Aborting the request tears the stream down.
    }
  })()

  const waitFor = async (
    predicate: (event: EventEnvelope) => boolean,
  ): Promise<EventEnvelope> => {
    const deadline = Date.now() + 2000
    while (Date.now() <= deadline) {
      const found = events.find(predicate)
      if (found) return found
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(
      `Timed out waiting for an SSE event; received: ${events.map((event) => event.type).join(", ")}`,
    )
  }

  const waitForCount = async (type: string, count: number): Promise<void> => {
    await waitFor(() => events.filter((event) => event.type === type).length >= count)
  }

  const close = async (): Promise<void> => {
    closed = true
    abort.abort()
    await reader.cancel().catch(() => {})
    await pump.catch(() => {})
  }

  return { events, rawText: () => raw, waitFor, waitForCount, close }
}

export async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}
