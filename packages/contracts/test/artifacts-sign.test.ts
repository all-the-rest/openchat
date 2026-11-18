import { describe, expect, it } from "vitest"
import { ARTIFACT_URL_TTL_SECONDS } from "../src/artifacts"
import { ArtifactSigner, buildUrl, expiresAt } from "../src/artifacts/sign"

const KEY = "test-artifact-signing-key-0123456789"
const OTHER_KEY = "test-artifact-signing-key-9876543210"
const NOW = 1_700_000_000
const ID = "a".repeat(64)

/**
 * Minted before the signer moved out of `apps/server/src/artifacts-sign.ts`
 * (at 41337f1) with `KEY` over `${ID}\n1700000060`. The wire form is frozen:
 * a URL this repository emitted then must still verify now.
 */
const LEGACY_EXP = 1_700_000_060
const LEGACY_SIGNATURE = "B5sIPO-k4p_HkPSqIHGGwJJYJ8z_oXy5HOqRghUVkD8"

function signer(key = KEY, nowMs = NOW * 1000): ArtifactSigner {
  return new ArtifactSigner({ key, now: () => nowMs })
}

function url(id = ID, exp = NOW + 60, key = KEY): string {
  return buildUrl("http://artifacts.test", id, exp, signer(key).sign(id, exp))
}

describe("artifact URL signing", () => {
  it("signs the id and the expiry as unpadded base64url", () => {
    const signature = signer().sign(ID, NOW + 60)
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(signature).not.toContain("=")
    expect(signer().sign(ID, NOW + 60)).toBe(signature)
    expect(signer().sign(ID, NOW + 61)).not.toBe(signature)
    expect(signer().sign("b".repeat(64), NOW + 60)).not.toBe(signature)
    expect(signer(OTHER_KEY).sign(ID, NOW + 60)).not.toBe(signature)
  })

  it("builds an absolute URL and drops a trailing slash", () => {
    const signature = signer().sign(ID, NOW + 60)
    const expected = `https://artifacts.example.com/a/${ID}?exp=${NOW + 60}&sig=${signature}`
    expect(buildUrl("https://artifacts.example.com", ID, NOW + 60, signature)).toBe(expected)
    expect(buildUrl("https://artifacts.example.com///", ID, NOW + 60, signature)).toBe(expected)
  })

  it("expires a URL minted now after the TTL", () => {
    expect(expiresAt(NOW * 1000 + 999)).toBe(NOW + ARTIFACT_URL_TTL_SECONDS)
    expect(expiresAt(NOW * 1000)).toBe(NOW + ARTIFACT_URL_TTL_SECONDS)
    expect(signer().expiry()).toBe(NOW + ARTIFACT_URL_TTL_SECONDS)
  })

  it("mints a URL and an ISO expiry from the injected clock", () => {
    const minted = signer().mint("http://artifacts.test", ID)
    const exp = NOW + ARTIFACT_URL_TTL_SECONDS
    expect(minted.expiresAt).toBe(new Date(exp * 1000).toISOString())
    expect(minted.url).toBe(url(ID, exp))
  })

  it("accepts a fresh signed URL", () => {
    const exp = NOW + ARTIFACT_URL_TTL_SECONDS
    const signature = signer().sign(ID, exp)
    expect(signer().verify(ID, String(exp), signature)).toBe(true)
    expect(signer(KEY, (exp - 1) * 1000).verify(ID, String(exp), signature)).toBe(true)
  })

  it("rejects an expired URL", () => {
    const exp = NOW
    const signature = signer().sign(ID, exp)
    expect(signer(KEY, NOW * 1000).verify(ID, String(exp), signature)).toBe(false)
    expect(signer(KEY, (NOW + 1) * 1000).verify(ID, String(exp), signature)).toBe(false)
  })

  it("rejects a URL minted for the far future", () => {
    const ceiling = NOW + ARTIFACT_URL_TTL_SECONDS + 60
    expect(signer().verify(ID, String(ceiling), signer().sign(ID, ceiling))).toBe(true)
    const tooFar = ceiling + 1
    expect(signer().verify(ID, String(tooFar), signer().sign(ID, tooFar))).toBe(false)
  })

  it("rejects a signature from another key, id or expiry", () => {
    const exp = NOW + 60
    const signature = signer().sign(ID, exp)
    expect(signer(OTHER_KEY).verify(ID, String(exp), signature)).toBe(false)
    expect(signer().verify("b".repeat(64), String(exp), signature)).toBe(false)
    expect(signer().verify(ID, String(exp + 1), signature)).toBe(false)
  })

  it("rejects a tampered signature after an equal-length compare", () => {
    const exp = NOW + 60
    const signature = signer().sign(ID, exp)
    const flipped = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`
    expect(signer().verify(ID, String(exp), flipped)).toBe(false)
    // Same length, different bytes: the compare, not the shape, decides.
    expect(Buffer.from(flipped, "base64url")).toHaveLength(32)
  })

  it.each([
    ["uppercase id", "A".repeat(64)],
    ["short id", "a".repeat(63)],
    ["id with a slash", `${"a".repeat(63)}/`],
    ["empty id", ""],
  ])("rejects an unshaped id: %s", (_label, id) => {
    const exp = String(NOW + 60)
    expect(signer().verify(id, exp, signer().sign(id, Number(exp)))).toBe(false)
  })

  it.each([
    ["exponent", "1e9"],
    ["leading space", " 1700000060"],
    ["plus sign", "+1700000060"],
    ["fraction", "1700000060.5"],
    ["empty", ""],
    ["negative", "-1"],
  ])("rejects an unshaped exp: %s", (_label, exp) => {
    expect(signer().verify(ID, exp, signer().sign(ID, Number(exp) || 0))).toBe(false)
  })

  it.each([
    ["padded", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa="],
    ["too short", "aaaaaaaaaaa"],
    ["foreign alphabet", "!".repeat(43)],
    ["whitespace", ` ${"a".repeat(42)}`],
    ["empty", ""],
  ])("rejects an unshaped signature: %s", (_label, signature) => {
    expect(signer().verify(ID, String(NOW + 60), signature)).toBe(false)
  })

  it("never throws on hostile input", () => {
    const hostile = ["", "\u0000", "\uD800", "a".repeat(10_000), "../".repeat(20)]
    for (const value of hostile) {
      expect(() => signer().verify(value, value, value)).not.toThrow()
      expect(signer().verify(value, value, value)).toBe(false)
    }
  })

  it("verifies a token minted before the move and re-mints it byte for byte", () => {
    // Compatibility fixture, not a round trip: the token was produced by the
    // old module. If the message format, the key handling or the encoding
    // changed, this fails even though every self-round-trip test still passes.
    const beforeExpiry = signer(KEY, (LEGACY_EXP - 1) * 1000)
    expect(beforeExpiry.verify(ID, String(LEGACY_EXP), LEGACY_SIGNATURE)).toBe(true)
    expect(beforeExpiry.sign(ID, LEGACY_EXP)).toBe(LEGACY_SIGNATURE)
    expect(buildUrl("http://artifacts.test", ID, LEGACY_EXP, LEGACY_SIGNATURE)).toBe(
      `http://artifacts.test/a/${ID}?exp=${LEGACY_EXP}&sig=${LEGACY_SIGNATURE}`,
    )
  })

  it("verifies its own minted URL after a URL round trip", () => {
    const signed = new URL(url())
    expect(
      signer(KEY, (NOW + 1) * 1000).verify(
        signed.pathname.split("/").pop() ?? "",
        signed.searchParams.get("exp") ?? "",
        signed.searchParams.get("sig") ?? "",
      ),
    ).toBe(true)
  })
})
