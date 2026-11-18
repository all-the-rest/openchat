import { createServer, request as httpRequest } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { mintTicket } from "@openchat/code-ticket"
import type { MintTicketOptions } from "@openchat/code-ticket"
import type { Hono } from "hono"
import { createApp } from "../src/app"
import type { AppEnv, AppOptions } from "../src/app"
import { loadEnv } from "../src/env"
import type { EnvConfig } from "../src/env"
import { createNodeServer } from "../src/node"
import { TicketReplayCache } from "../src/replay"
import { createSessionValue } from "../src/session"

export const TICKET_SECRET = "test-ticket-secret-test-ticket-secret"
export const OPENCODE_PASSWORD = "opencode-test-password"
export const APP_ORIGIN = "http://app.openchat.test"
export const CODE_HOST_ORIGIN = "http://code.openchat.test"

export function makeConfig(overrides: Record<string, string | undefined> = {}): EnvConfig {
  return loadEnv({
    source: {
      CODE_TICKET_SECRET: TICKET_SECRET,
      OPENCODE_PASSWORD,
      APP_ORIGIN,
      CODE_HOST_ORIGIN,
      ...overrides,
    },
    warn: () => {},
  })
}

export interface TestApp {
  app: Hono<AppEnv>
  config: EnvConfig
  replay: TicketReplayCache
  logs: string[]
}

export type TestAppOptions = Partial<Omit<AppOptions, "config" | "replay" | "log">>

export function makeApp(
  overrides: Record<string, string | undefined> = {},
  options: TestAppOptions = {},
): TestApp {
  const config = makeConfig(overrides)
  const replay = new TicketReplayCache()
  const logs: string[] = []
  const app = createApp({ config, replay, log: (message) => logs.push(message), ...options })
  return { app, config, replay, logs }
}

export function ticketFor(
  config: EnvConfig,
  overrides: Partial<MintTicketOptions> = {},
): string {
  return mintTicket({
    sub: "owner",
    codeHost: config.CODE_HOST_ORIGIN,
    secret: config.CODE_TICKET_SECRET,
    ttlSeconds: 30,
    ...overrides,
  })
}

export function cookieFor(config: EnvConfig, now = Date.now()): string {
  const value = createSessionValue(
    {
      secret: config.CODE_TICKET_SECRET,
      ttlSeconds: config.CODE_SESSION_TTL_SECONDS,
      secureCookie: config.COOKIE_SECURE,
    },
    "owner",
    now,
  )
  return `oc_code=${value}`
}

export function sessionCookieValue(response: Response): string {
  return response.headers.getSetCookie()[0] ?? ""
}

/** A stub OpenCode listener on an ephemeral loopback port. */
export interface StubRequest {
  method: string
  url: string
  headers: IncomingMessage["headers"]
  body: string
}

export interface StubUpstream {
  url: string
  requests: StubRequest[]
  close(): Promise<void>
}

export type StubHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  body: string,
) => void

export async function startUpstream(handler: StubHandler): Promise<StubUpstream> {
  const requests: StubRequest[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8")
      requests.push({
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: request.headers,
        body,
      })
      handler(request, response, body)
    })
  })
  const port = await listen(server)
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => closeServer(server),
  }
}

/** A real listener around the app, needed for raw header and streaming tests. */
export interface RunningCodeHost {
  origin: string
  app: Hono<AppEnv>
  config: EnvConfig
  logs: string[]
  close(): Promise<void>
}

export async function startCodeHost(
  overrides: Record<string, string | undefined> = {},
  options: TestAppOptions = {},
): Promise<RunningCodeHost> {
  const config = makeConfig(overrides)
  const logs: string[] = []
  const app = createApp({ config, log: (message) => logs.push(message), ...options })
  const server = createNodeServer(app)
  const port = await listen(server)
  return {
    origin: `http://127.0.0.1:${port}`,
    app,
    config,
    logs,
    close: () => closeServer(server),
  }
}

export interface RawResponse {
  status: number
  rawHeaders: string[]
  headers: IncomingMessage["headers"]
  body: string
}

/** Node-level request so duplicate headers (two CSP lines) stay observable. */
export function rawRequest(
  origin: string,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, origin)
    const request = httpRequest(
      url,
      { method: init.method ?? "GET", headers: init.headers ?? {} },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            rawHeaders: response.rawHeaders,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        })
      },
    )
    request.on("error", reject)
    if (init.body !== undefined) request.write(init.body)
    request.end()
  })
}

/** Returns every raw value for a header name. */
export function rawHeaderValues(rawHeaders: string[], name: string): string[] {
  const values: string[] = []
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name.toLowerCase()) {
      values.push(rawHeaders[index + 1] ?? "")
    }
  }
  return values
}

export function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address && typeof address === "object") resolve(address.port)
      else reject(new Error("Server did not report a port"))
    })
  })
}

export function closeServer(server: Server): Promise<void> {
  server.closeAllConnections()
  return new Promise((resolve) => server.close(() => resolve()))
}
