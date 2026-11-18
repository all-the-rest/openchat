import { createHash } from "node:crypto"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { createServer, request as httpRequest } from "node:http"
import type { IncomingMessage, Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Hono } from "hono"
import { ArtifactSigner } from "@openchat/contracts/artifacts/sign"
import { createApp } from "../src/app"
import type { AppOptions } from "../src/app"
import { loadEnv } from "../src/env"
import type { EnvConfig } from "../src/env"
import { createNodeServer } from "../src/http"

export const KEY = "test-artifact-signing-key-0123456789"
export const FRAME_ANCESTORS = "http://chat.example.com"

export function makeConfig(overrides: Record<string, string | undefined> = {}): EnvConfig {
  return loadEnv({
    source: {
      ARTIFACT_SIGNING_KEY: KEY,
      ARTIFACT_FRAME_ANCESTORS: FRAME_ANCESTORS,
      ...overrides,
    },
    warn: () => {},
  })
}

export interface ArtifactFixture {
  dir: string
  id: string
  html: string
}

/** Writes one stored artifact the way the BFF would: `<dir>/<sha256>/index.html`. */
export async function artifactFixture(
  html: string,
  dir?: string,
): Promise<ArtifactFixture> {
  const root = dir ?? (await mkdtemp(join(tmpdir(), "openchat-artifact-host-")))
  const id = createHash("sha256").update(Buffer.from(html, "utf8")).digest("hex")
  await mkdir(join(root, id), { recursive: true })
  await writeFile(join(root, id, "index.html"), html)
  return { dir: root, id, html }
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/** `/a/<id>?exp=…&sig=…`, signed with the shared key. */
export function signedPath(
  id: string,
  options: { exp?: number; key?: string } = {},
): string {
  const exp = options.exp ?? nowSeconds() + 300
  const signature = new ArtifactSigner({ key: options.key ?? KEY }).sign(id, exp)
  return `/a/${id}?exp=${exp}&sig=${signature}`
}

export interface RunningHost {
  origin: string
  app: Hono
  config: EnvConfig
  close(): Promise<void>
}

export async function startHost(
  overrides: Record<string, string | undefined> = {},
  options: Partial<Omit<AppOptions, "config">> = {},
): Promise<RunningHost> {
  const config = makeConfig(overrides)
  const app = createApp({ config, ...options })
  const server = createNodeServer(app)
  const port = await listen(server)
  return {
    origin: `http://127.0.0.1:${port}`,
    app,
    config,
    close: () => closeServer(server),
  }
}

export interface RawResponse {
  status: number
  rawHeaders: string[]
  headers: IncomingMessage["headers"]
  body: string
  /** Exact bytes, so binary artifacts can be compared without a UTF-8 round trip. */
  bytes: Buffer
}

/** Node-level request so duplicate headers (two CSP lines) stay observable. */
export function rawRequest(
  origin: string,
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      new URL(path, origin),
      { method: init.method ?? "GET", headers: init.headers ?? {} },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () => {
          const bytes = Buffer.concat(chunks)
          resolve({
            status: response.statusCode ?? 0,
            rawHeaders: response.rawHeaders,
            headers: response.headers,
            body: bytes.toString("utf8"),
            bytes,
          })
        })
      },
    )
    request.on("error", reject)
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
