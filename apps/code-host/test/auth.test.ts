import { describe, expect, it } from "vitest"
import { APP_ORIGIN, makeApp, sessionCookieValue, ticketFor } from "./helpers"

const NOW = 1_700_000_000_000

function authPath(ticket: string, next = "/"): string {
  return `/__auth?ticket=${encodeURIComponent(ticket)}&next=${encodeURIComponent(next)}`
}

describe("ticket exchange", () => {
  it("sets a host-only session cookie and redirects to next", async () => {
    const { app, config } = makeApp()
    const response = await app.request(authPath(ticketFor(config), "/sessions/abc"))

    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe("/sessions/abc")
    const cookie = sessionCookieValue(response)
    expect(cookie.startsWith("oc_code=v1.")).toBe(true)
    expect(cookie).toContain("Path=/")
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Lax")
    expect(cookie).toContain("Max-Age=43200")
    expect(cookie).not.toContain("Secure")
    expect(cookie.toLowerCase()).not.toContain("domain")
  })

  it("marks the cookie Secure when configured, still without a Domain", async () => {
    const { app, config } = makeApp({ COOKIE_SECURE: "1" })
    const response = await app.request(authPath(ticketFor(config)))

    expect(response.status).toBe(302)
    const cookie = sessionCookieValue(response)
    expect(cookie).toContain("; Secure")
    expect(cookie.toLowerCase()).not.toContain("domain")
  })

  it("rejects a replayed ticket without setting a cookie", async () => {
    const { app, config } = makeApp()
    const ticket = ticketFor(config)

    const first = await app.request(authPath(ticket))
    expect(first.status).toBe(302)
    expect(sessionCookieValue(first)).not.toBe("")

    const second = await app.request(authPath(ticket))
    expect(second.status).toBe(401)
    expect(second.headers.getSetCookie()).toEqual([])
    expect(await second.text()).toContain("Sign in to Open Code")
  })

  it("rejects an expired ticket", async () => {
    const { app, config } = makeApp({}, { now: () => NOW })
    const ticket = ticketFor(config, { now: NOW - 61_000, ttlSeconds: 60 })
    const response = await app.request(authPath(ticket))
    expect(response.status).toBe(401)
    expect(response.headers.getSetCookie()).toEqual([])
  })

  it("rejects a tampered ticket", async () => {
    const { app, config } = makeApp()
    const ticket = ticketFor(config)
    const tampered = ticket.slice(0, -1) + (ticket.endsWith("A") ? "B" : "A")
    const response = await app.request(authPath(tampered))
    expect(response.status).toBe(401)
  })

  it("rejects a ticket minted for another Code host", async () => {
    const { app, config } = makeApp()
    const ticket = ticketFor(config, { codeHost: "https://code.elsewhere.test" })
    const response = await app.request(authPath(ticket))
    expect(response.status).toBe(401)
  })

  it("rejects a missing ticket", async () => {
    const { app } = makeApp()
    const response = await app.request("/__auth?next=/")
    expect(response.status).toBe(401)
  })

  it("treats a missing next as /", async () => {
    const { app, config } = makeApp()
    const response = await app.request(`/__auth?ticket=${encodeURIComponent(ticketFor(config))}`)
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe("/")
  })

  it("falls back to / for every open-redirect attempt", async () => {
    const { app, config } = makeApp()
    const attempts = [
      "//evil.test",
      "https://evil.test",
      "/\\evil.test",
      "/%5Cevil.test",
      "/%2Fevil.test",
      "/javascript:alert(1)",
      " /space",
    ]
    for (const attempt of attempts) {
      const response = await app.request(authPath(ticketFor(config), attempt))
      expect(response.status).toBe(302)
      expect(response.headers.get("location"), attempt).toBe("/")
    }
  })

  it("keeps a valid path including its query", async () => {
    const { app, config } = makeApp()
    const response = await app.request(authPath(ticketFor(config), "/sessions/1?tab=diff"))
    expect(response.headers.get("location")).toBe("/sessions/1?tab=diff")
  })

  it("logs a rejection without the ticket value", async () => {
    const { app, config, logs } = makeApp()
    const ticket = ticketFor(config)
    await app.request(authPath(ticket))
    await app.request(authPath(ticket))
    const text = logs.join("\n")
    expect(text).toContain("ticket rejected")
    expect(text).not.toContain(ticket.split(".")[1] ?? "unreachable")
  })
})

describe("sign-in page", () => {
  it("offers the app login and posts the unauthenticated state to APP_ORIGIN", async () => {
    const { app } = makeApp()
    const response = await app.request("/__sign-in")

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/html")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    expect(response.headers.get("content-security-policy")).toBe(
      `frame-ancestors ${APP_ORIGIN}`,
    )

    const body = await response.text()
    expect(body).toContain(`${APP_ORIGIN}/login`)
    expect(body).toContain("window.parent === window")
    expect(body).toContain("window.parent.postMessage")
    expect(body).toContain('state: "unauthenticated"')
    expect(body).toContain(JSON.stringify(APP_ORIGIN))
    expect(body).not.toContain('"*"')
  })

  it("answers a navigation 401 with the page", async () => {
    const { app } = makeApp()
    const response = await app.request("/", { headers: { accept: "text/html" } })

    expect(response.status).toBe(401)
    expect(response.headers.get("content-type")).toContain("text/html")
    expect(response.headers.getSetCookie()).toEqual([])
    expect(await response.text()).toContain("window.parent.postMessage")
  })

  it("answers an SPA API request with the JSON 401", async () => {
    const { app } = makeApp()
    const response = await app.request("/api/session", {
      headers: { accept: "application/json" },
    })

    expect(response.status).toBe(401)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({ error: "code_session_required" })
  })

  it("answers a non-navigation page request with JSON", async () => {
    const { app } = makeApp()
    const response = await app.request("/", { headers: { accept: "*/*" } })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: "code_session_required" })
  })
})
