import type { Context } from "hono"
import { describe, expect, it } from "vitest"
import type { AppEnv } from "../src/app"
import { clientAddress } from "../src/middleware"
import { FixedWindowThrottle } from "../src/throttle"
import { login, makeServer } from "./helpers"

const REAL_CLIENT = "203.0.113.7"
const TICKET_ENV = {
  CODE_HOST_ORIGIN: "http://code.example:8090",
  CODE_TICKET_SECRET: "test-code-ticket-secret",
  CODE_TICKET_TTL_SECONDS: "30",
}

/** Minimal context: `clientAddress` only reads headers and the socket address. */
function address(
  headers: Record<string, string>,
  trustProxy: boolean,
  remoteAddress?: string,
): string {
  const context = {
    req: { header: (name: string) => headers[name.toLowerCase()] },
    env: remoteAddress === undefined ? undefined : { remoteAddress },
  } as unknown as Context<AppEnv>
  return clientAddress(context, trustProxy)
}

/** The first entry is what a client can write; the proxy appends the real hop. */
function appended(index: number, real = REAL_CLIENT): Record<string, string> {
  return { "x-forwarded-for": `198.51.100.${index}, ${real}` }
}

function badLogin(headers: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ user: "owner", password: "wrong" }),
  }
}

function mint(server: ReturnType<typeof makeServer>, cookie: string, headers: Record<string, string>) {
  return server.app.request("/api/code/ticket", { headers: { cookie, ...headers } })
}

describe("clientAddress", () => {
  it("uses the socket address when the proxy is not trusted", () => {
    expect(
      address({ "x-forwarded-for": "203.0.113.99", "x-real-ip": "203.0.113.98" }, false, "10.0.0.5"),
    ).toBe("10.0.0.5")
  })

  it("falls back to the remote address when no header is present", () => {
    expect(address({}, true, "10.0.0.5")).toBe("10.0.0.5")
  })

  it("reads a single forwarded entry", () => {
    expect(address({ "x-forwarded-for": "203.0.113.7" }, true, "10.0.0.5")).toBe("203.0.113.7")
  })

  it("takes the last entry a client cannot forge, not the first", () => {
    expect(
      address({ "x-forwarded-for": `198.51.100.9, ${REAL_CLIENT}` }, true, "10.0.0.5"),
    ).toBe(REAL_CLIENT)
  })

  it("skips empty and whitespace-only entries", () => {
    expect(address({ "x-forwarded-for": "a, b, , c" }, true, "10.0.0.5")).toBe("c")
    expect(address({ "x-forwarded-for": "a, b, ,  " }, true, "10.0.0.5")).toBe("b")
  })

  it("falls back to X-Real-IP", () => {
    expect(address({ "x-real-ip": " 198.51.100.4 " }, true, "10.0.0.5")).toBe("198.51.100.4")
  })

  it("ignores an empty X-Real-IP", () => {
    expect(address({ "x-real-ip": "   " }, true, "10.0.0.5")).toBe("10.0.0.5")
  })

  it("caps the bucket key at 128 characters", () => {
    const huge = "a".repeat(500)
    const key = address({ "x-forwarded-for": `forged, ${huge}` }, true, "10.0.0.5")
    expect(key).toHaveLength(128)
    expect(key).toBe("a".repeat(128))
  })

  it("never returns an empty string", () => {
    expect(address({}, true, "")).toBe("local")
    expect(address({}, false, "")).toBe("local")
  })
})

describe("forwarded address through the routes", () => {
  it("keeps rotated first entries in one ticket bucket", async () => {
    const throttle = new FixedWindowThrottle({ limit: 20, windowMs: 60_000, now: () => 0 })
    const server = makeServer({
      env: { ...TICKET_ENV, TRUST_PROXY: "1" },
      codeTicketThrottle: throttle,
    })
    const cookie = await login(server)

    const statuses: number[] = []
    for (let index = 0; index < 25; index += 1) {
      const response = await mint(server, cookie, appended(index))
      statuses.push(response.status)
      if (response.status === 429) {
        expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0)
      }
    }
    expect(statuses.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => 200))
    expect(statuses.slice(20)).toEqual(Array.from({ length: 5 }, () => 429))
  })

  it("keeps rotated first entries in one login-failure bucket", async () => {
    const server = makeServer({ env: { TRUST_PROXY: "1" } })
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await server.app.request(
        "/api/auth/login",
        badLogin(appended(attempt)),
      )
      expect(response.status).toBe(401)
    }
    const blocked = await server.app.request("/api/auth/login", badLogin(appended(10)))
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0)
  })

  it("keeps two different last entries in separate buckets", async () => {
    const server = makeServer({ env: { TRUST_PROXY: "1" } })
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await server.app.request(
        "/api/auth/login",
        badLogin(appended(attempt)),
      )
      expect(response.status).toBe(401)
    }
    expect(
      (await server.app.request("/api/auth/login", badLogin(appended(11)))).status,
    ).toBe(429)

    const other = await server.app.request(
      "/api/auth/login",
      badLogin(appended(12, "198.51.100.200")),
    )
    expect(other.status).toBe(401)
  })

  it("ignores rotated forwarding headers without TRUST_PROXY", async () => {
    const throttle = new FixedWindowThrottle({ limit: 20, windowMs: 60_000, now: () => 0 })
    const server = makeServer({ env: TICKET_ENV, codeTicketThrottle: throttle })
    const cookie = await login(server)

    const statuses: number[] = []
    for (let index = 0; index < 21; index += 1) {
      const response = await mint(server, cookie, {
        "x-forwarded-for": `198.51.100.${index}`,
        "x-real-ip": `198.51.100.${index}`,
      })
      statuses.push(response.status)
    }
    expect(statuses.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => 200))
    expect(statuses[20]).toBe(429)
  })
})
