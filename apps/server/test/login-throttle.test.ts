import { describe, expect, it } from "vitest"
import { FakeBackend } from "@openchat/opencode"
import { createApp } from "../src/app"
import type { CredentialVerifier } from "../src/auth"
import { VerificationGate } from "../src/throttle"
import { basicHeader, json, login, makeConfig, makeServer } from "./helpers"

const PASSWORD = "secret-password"

function loginRequest(password = PASSWORD) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: "owner", password }),
  }
}

function badLoginRequest() {
  return loginRequest("wrong")
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe("login budget ordering", () => {
  it("counts a parallel burst before bcrypt, so at most ten reach the verifier", async () => {
    let calls = 0
    const verify: CredentialVerifier = async () => {
      calls += 1
      // Real bcrypt yields while it runs; hold the tick so the burst overlaps
      // the same way it did when the review measured five parallel attempts.
      await new Promise((resolve) => setTimeout(resolve, 10))
      return null
    }
    // Permits above the burst: this test isolates the throttle, not the gate.
    const server = makeServer({
      verificationGate: new VerificationGate(20),
      verify,
    })

    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        server.app.request("/api/auth/login", badLoginRequest()),
      ),
    )

    expect(calls).toBe(10)
    expect(responses.filter((response) => response.status === 401)).toHaveLength(10)
    expect(responses.filter((response) => response.status === 429)).toHaveLength(10)
  })

  it("does not keep a successful attempt counted for the rest of the window", async () => {
    const server = makeServer()
    const success = await server.app.request("/api/auth/login", loginRequest())
    expect(success.status).toBe(200)

    // The success cleared the bucket, so a full budget of ten failures follows.
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const response = await server.app.request("/api/auth/login", badLoginRequest())
      expect(response.status, `attempt ${attempt}`).toBe(401)
    }
    const blocked = await server.app.request("/api/auth/login", badLoginRequest())
    expect(blocked.status).toBe(429)
  })
})

describe("login verification gate", () => {
  it("caps in-flight verifications and answers 429 with a fixed body", async () => {
    let hold = true
    let entered = 0
    const releases: Array<() => void> = []
    const verify: CredentialVerifier = async () => {
      if (!hold) return null
      entered += 1
      await new Promise<void>((resolve) => releases.push(resolve))
      return null
    }
    const gate = new VerificationGate(2)
    const server = makeServer({ verificationGate: gate, verify })

    const responses: Response[] = []
    const pending = Array.from({ length: 5 }, () =>
      Promise.resolve(server.app.request("/api/auth/login", badLoginRequest())).then(
        (response) => {
          responses.push(response)
          return response
        },
      ),
    )

    await until(() => responses.filter((response) => response.status === 429).length === 3)
    expect(entered).toBe(2)
    expect(gate.inFlight).toBe(2)

    const busy = responses.find((response) => response.status === 429)
    expect(busy).toBeDefined()
    if (busy) {
      expect(busy.headers.get("retry-after")).toBe("1")
      expect(await json(busy)).toEqual({
        error: { code: "server_busy", message: "Too many concurrent login attempts" },
      })
    }

    hold = false
    for (const release of releases) release()
    await Promise.all(pending)

    expect(responses.filter((response) => response.status === 401)).toHaveLength(2)
    expect(gate.inFlight).toBe(0)
  })

  it("releases the permit after a wrong password and after a success", async () => {
    const gate = new VerificationGate(1)
    const server = makeServer({ verificationGate: gate })

    const wrong = await server.app.request("/api/auth/login", badLoginRequest())
    expect(wrong.status).toBe(401)
    expect(gate.inFlight).toBe(0)

    const right = await server.app.request("/api/auth/login", loginRequest())
    expect(right.status).toBe(200)
    expect(gate.inFlight).toBe(0)
  })

  it("releases the permit when the verifier throws", async () => {
    const gate = new VerificationGate(1)
    let calls = 0
    const verify: CredentialVerifier = async () => {
      calls += 1
      if (calls === 1) throw new Error("bcrypt rejected the stored hash")
      return null
    }
    const server = makeServer({ verificationGate: gate, verify })

    const first = await server.app.request("/api/auth/login", loginRequest())
    expect(first.status).toBe(500)
    expect(gate.inFlight).toBe(0)

    // A leaked permit would answer this one with 429 instead of verifying.
    const second = await server.app.request("/api/auth/login", loginRequest())
    expect(second.status).toBe(401)
    expect(calls).toBe(2)
  })
})

describe("basic auth throttle", () => {
  function basicApp() {
    const config = makeConfig({ AUTH_MODE: "basic" })
    return createApp({
      config,
      backend: new FakeBackend({ delayMs: 0, workspace: config.WORKSPACE_DIR }),
    })
  }

  const wrong = { authorization: basicHeader("owner", "wrong") }

  it("throttles a Basic header on a read route too, not only login", async () => {
    const app = basicApp()
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const response = await app.request("/api/info", { headers: wrong })
      expect(response.status, `attempt ${attempt}`).toBe(401)
    }
    const blocked = await app.request("/api/info", { headers: wrong })
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0)
    expect(await json(blocked)).toMatchObject({ error: { code: "too_many_requests" } })
  })

  it("clears the Basic budget after a successful header", async () => {
    const app = basicApp()
    for (let attempt = 1; attempt <= 9; attempt += 1) {
      expect((await app.request("/api/info", { headers: wrong })).status).toBe(401)
    }
    const accepted = await app.request("/api/info", {
      headers: { authorization: basicHeader() },
    })
    expect(accepted.status).toBe(200)

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      expect((await app.request("/api/info", { headers: wrong })).status).toBe(401)
    }
    expect((await app.request("/api/info", { headers: wrong })).status).toBe(429)
  })
})
