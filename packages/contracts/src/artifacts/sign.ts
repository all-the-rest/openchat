import { Buffer } from "node:buffer"
import { createHmac, timingSafeEqual } from "node:crypto"
import { ARTIFACT_URL_TTL_SECONDS } from "./index"
import { isArtifactId } from "./id"

/**
 * Signed artifact URLs, shared verbatim by the BFF (mints them) and the
 * artifact host (verifies them). The module is pure: no HTTP, no filesystem.
 *
 * Import it as `@openchat/contracts/artifacts/sign`. It is a subpath, not a
 * re-export of the package root: the module needs `node:crypto`, and the root
 * index is what the browser bundle imports.
 */

/** Unix seconds, digits only; a `+`, a space or a fractional part is refused. */
const EXP_PATTERN = /^[0-9]{1,15}$/
/** HMAC-SHA256 is 32 bytes, which is 43 unpadded base64url characters. */
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/
/**
 * A URL cannot be minted for the far future: the receiver accepts at most the
 * TTL below, plus one minute of clock skew between BFF and host.
 */
const EXPIRY_SKEW_SECONDS = 60

/** Unix seconds a URL minted at `nowMs` expires at. */
export function expiresAt(nowMs: number): number {
  return Math.floor(nowMs / 1000) + ARTIFACT_URL_TTL_SECONDS
}

/** Absolute document URL; a trailing slash in `base` is dropped. */
export function buildUrl(base: string, id: string, exp: number, sig: string): string {
  return `${base.replace(/\/+$/, "")}/a/${id}?exp=${exp}&sig=${sig}`
}

export interface ArtifactSignerOptions {
  /** Shared HMAC key (`ARTIFACT_SIGNING_KEY`); validated at boot, not here. */
  key: string
  /** Injected clock in epoch milliseconds; defaults to `Date.now`. */
  now?: () => number
}

/**
 * Signs and verifies one artifact URL. Both processes construct it with the
 * same key; only the BFF also calls `mint()`, because only the BFF knows the
 * public base URL.
 */
export class ArtifactSigner {
  private readonly key: string
  private readonly now: () => number

  constructor(options: ArtifactSignerOptions) {
    this.key = options.key
    this.now = options.now ?? (() => Date.now())
  }

  /** Unix seconds a URL minted now expires at. */
  expiry(): number {
    return expiresAt(this.now())
  }

  /**
   * `base64url(HMAC-SHA256(key, id + "\n" + exp))`, unpadded. The id is part
   * of the message, so a signature cannot be replayed on another artifact and
   * the newline keeps `id` and `exp` from running into each other.
   */
  sign(id: string, exp: number): string {
    return createHmac("sha256", this.key).update(`${id}\n${exp}`).digest("base64url")
  }

  /**
   * Validates a URL's `exp`/`sig` pair. The shape check runs first, so hostile
   * input never reaches the HMAC or a length-dependent compare; then the
   * signature compares in constant time; only then does the clock decide, so
   * an expired URL is rejected only when its signature was valid.
   */
  verify(id: string, exp: string, sig: string): boolean {
    if (!isArtifactId(id)) return false
    if (!EXP_PATTERN.test(exp)) return false
    if (!SIGNATURE_PATTERN.test(sig)) return false

    const expires = Number(exp)
    if (!Number.isSafeInteger(expires)) return false

    const given = Buffer.from(sig, "base64url")
    const expected = Buffer.from(this.sign(id, expires), "base64url")
    if (given.length !== expected.length) return false
    if (!timingSafeEqual(given, expected)) return false

    const nowSeconds = Math.floor(this.now() / 1000)
    return (
      expires > nowSeconds &&
      expires <= nowSeconds + ARTIFACT_URL_TTL_SECONDS + EXPIRY_SKEW_SECONDS
    )
  }

  /** A freshly signed URL and its ISO 8601 expiry. */
  mint(base: string, id: string): { url: string; expiresAt: string } {
    const exp = this.expiry()
    return {
      url: buildUrl(base, id, exp, this.sign(id, exp)),
      expiresAt: new Date(exp * 1000).toISOString(),
    }
  }
}
