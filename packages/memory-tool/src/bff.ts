import type { MemoryOp, MemoryOpResult } from "@openchat/contracts"

/**
 * The one HTTP call the tool makes: `POST /internal/memory` on the BFF with the
 * shared bearer token. Fixed error mapping, no redirect and no upstream text:
 * the model gets a short code/message line, never a paragraph from the BFF or
 * a fragment of an HTML error page. The body is the `MemoryOp` JSON defined by
 * `@openchat/contracts`; this process holds no store credentials of its own.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface BffOptions {
  /** Base URL of the BFF, e.g. `http://127.0.0.1:8787`. */
  bffUrl: string
  /** `MEMORY_INTERNAL_TOKEN`, shared with the BFF. Never logged. */
  token: string
  /** Injected for tests; defaults to `globalThis.fetch`. */
  fetch?: FetchLike
}

export type PostResult =
  | { ok: true; result: MemoryOpResult }
  | { ok: false; error: string }

const MEMORY_PATH = "/internal/memory"
const UNREACHABLE = "unreachable: the BFF did not answer; check OPENCHAT_BFF_URL"
const UNEXPECTED_BODY = "internal: the BFF answered an unexpected body"
const REDIRECTED = "internal: the BFF redirected the memory call"
const UNAUTHORIZED =
  "internal: the BFF rejected MEMORY_INTERNAL_TOKEN; the tool and the BFF must share the same value"

/** Status-only mapping. No upstream body is ever read into the error. */
export function statusError(status: number): string {
  switch (status) {
    case 400:
      return "internal: the BFF rejected the memory operation"
    case 401:
    case 403:
      return UNAUTHORIZED
    case 413:
      return "size: the memory operation exceeds the BFF body limit"
    case 415:
      return "internal: the BFF refused the request media type"
    case 429:
      return "busy: the memory operation budget is exhausted; retry in a minute"
    case 503:
      return "unavailable: the BFF has no memory store configured"
    default:
      return `internal: the BFF answered ${status}`
  }
}

export function memoryUrl(bffUrl: string): string {
  return `${bffUrl.replace(/\/+$/, "")}${MEMORY_PATH}`
}

/**
 * The BFF returns compact JSON for every op: a string for `index`, an object
 * or array for the rest. Anything that parsed as JSON is accepted; a non-JSON
 * body is rejected by `response.json()` before it can reach the model.
 */
function isMemoryOpResult(value: unknown): value is MemoryOpResult {
  return typeof value === "object" && value !== null
}

/** POST one MemoryOp through the BFF. No filesystem, no store, no logging. */
export async function postOp(options: BffOptions, op: MemoryOp): Promise<PostResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  let response: Response
  try {
    response = await fetchImpl(memoryUrl(options.bffUrl), {
      method: "POST",
      // Never follow a redirect: the target is fixed, and a redirect would
      // move the bearer token to wherever the answer points.
      redirect: "manual",
      credentials: "omit",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${options.token}`,
      },
      body: JSON.stringify(op),
    })
  } catch {
    return { ok: false, error: UNREACHABLE }
  }

  if (response.status >= 300 && response.status < 400) {
    return { ok: false, error: REDIRECTED }
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, error: statusError(response.status) }
  }

  let parsed: unknown
  try {
    parsed = (await response.json()) as unknown
  } catch {
    return { ok: false, error: UNEXPECTED_BODY }
  }
  if (!isMemoryOpResult(parsed)) return { ok: false, error: UNEXPECTED_BODY }
  return { ok: true, result: parsed }
}
