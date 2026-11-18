import { describe, expect, it, vi } from "vitest"

/**
 * The password check must run even when the username does not match: an
 * unknown user has to cost the same bcrypt round as a known one, otherwise the
 * response time confirms which half of the credential was wrong.
 *
 * `bcryptjs` is mocked here (and only here) so the assertion is "the check ran",
 * not a wall-clock measurement that a loaded CI box could occasionally miss.
 */
const { compare } = vi.hoisted(() => ({ compare: vi.fn(async () => false) }))
vi.mock("bcryptjs", () => ({ compare }))

import { verifyCredentials, type AuthSettings } from "../src/auth"

const HASH = "$2a$04$Yq4Me9RVGpnS4XyTf0tQPuN/p6CYrC22mxsDjzEp9Tpg3m6Qrlbpq"

function settings(overrides: Partial<AuthSettings> = {}): AuthSettings {
  return {
    mode: "session",
    user: "owner",
    password: "",
    passwordHash: HASH,
    secret: "0123456789abcdef0123456789abcdef",
    ttlSeconds: 3600,
    secureCookie: false,
    ...overrides,
  }
}

describe("verifyCredentials", () => {
  it("runs the bcrypt check even when the username does not match", async () => {
    compare.mockClear()
    const result = await verifyCredentials("someone-else", "secret-password", settings())

    expect(result).toBeNull()
    expect(compare).toHaveBeenCalledTimes(1)
  })

  it("runs the bcrypt check for a matching username with the wrong password", async () => {
    compare.mockClear()
    const result = await verifyCredentials("owner", "wrong", settings())

    expect(result).toBeNull()
    expect(compare).toHaveBeenCalledTimes(1)
  })

  it("returns the user only when both halves match", async () => {
    compare.mockClear()
    compare.mockResolvedValueOnce(true)
    const result = await verifyCredentials("owner", "secret-password", settings())

    expect(result).toBe("owner")
    expect(compare).toHaveBeenCalledTimes(1)
  })

  it("denies instead of throwing on a malformed hash", async () => {
    compare.mockClear()
    compare.mockRejectedValueOnce(new Error("Invalid salt version"))
    // Configuration rejects this shape at boot; the verifier still has to deny
    // if a hash reaches it, because a throw would be a different answer.
    const result = await verifyCredentials(
      "owner",
      "secret-password",
      settings({ passwordHash: "not-a-bcrypt-hash" }),
    )

    expect(result).toBeNull()
    expect(compare).toHaveBeenCalledTimes(1)
  })

  it("does not hash when the deployment carries a plaintext credential", async () => {
    compare.mockClear()
    const result = await verifyCredentials(
      "owner",
      "secret-password",
      settings({ password: "secret-password", passwordHash: "" }),
    )

    expect(result).toBe("owner")
    expect(compare).not.toHaveBeenCalled()
  })
})
