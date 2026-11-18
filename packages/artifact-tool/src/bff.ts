import type { ArtifactInternalCreateRequest, ArtifactWriteReceipt } from "@openchat/contracts"

/**
 * The one HTTP call the tool makes: `POST /internal/artifacts` on the BFF with
 * the shared bearer token. Fixed error mapping, no redirect and no upstream
 * text: the model gets a short instruction, never a paragraph from the BFF.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface BffOptions {
  /** Base URL of the BFF, e.g. `http://127.0.0.1:8787`. */
  bffUrl: string
  /** `ARTIFACT_INTERNAL_TOKEN`, shared with the BFF. Never logged. */
  token: string
  /** Injected for tests; defaults to `globalThis.fetch`. */
  fetch?: FetchLike
}

export type PostResult =
  | { ok: true; receipt: ArtifactWriteReceipt }
  | { ok: false; error: string }

const WRITE_PATH = "/internal/artifacts"
const UNREACHABLE = "unreachable: the BFF did not answer; check OPENCHAT_BFF_URL"
const UNEXPECTED_BODY = "internal: the BFF answered an unexpected body"
const REDIRECTED = "internal: the BFF redirected the write"
const UNAUTHORIZED =
  "internal: the BFF rejected ARTIFACT_INTERNAL_TOKEN; the tool and the BFF must share the same value"

/**
 * Status-only mapping. A 400 from the BFF means the compiled document failed
 * the store rules, which the model cannot repair by editing its app; it is an
 * internal fault, not a user error.
 */
export function statusError(status: number): string {
  switch (status) {
    case 400:
      return "internal: the BFF rejected the compiled document"
    case 401:
    case 403:
      return UNAUTHORIZED
    case 413:
      return "size: the compiled document exceeds the BFF body limit"
    case 415:
      return "internal: the BFF refused the request media type"
    case 429:
      return "busy: the artifact write budget is exhausted; retry in a minute"
    case 503:
      return "unavailable: the BFF has no artifact storage configured"
    default:
      return `internal: the BFF answered ${status}`
  }
}

function isReceipt(value: unknown): value is ArtifactWriteReceipt {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.artifactID === "string" &&
    record.artifactID.length > 0 &&
    typeof record.title === "string" &&
    typeof record.bytes === "number" &&
    Number.isSafeInteger(record.bytes) &&
    record.bytes >= 0
  )
}

export function writeUrl(bffUrl: string): string {
  return `${bffUrl.replace(/\/+$/, "")}${WRITE_PATH}`
}

export async function postDocument(
  options: BffOptions,
  body: ArtifactInternalCreateRequest,
): Promise<PostResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  let response: Response
  try {
    response = await fetchImpl(writeUrl(options.bffUrl), {
      method: "POST",
      // Never follow a redirect: the write target is fixed, and a redirect
      // would move the bearer token to wherever the answer points.
      redirect: "manual",
      credentials: "omit",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${options.token}`,
      },
      body: JSON.stringify(body),
    })
  } catch {
    return { ok: false, error: UNREACHABLE }
  }

  if (response.status >= 300 && response.status < 400) {
    return { ok: false, error: REDIRECTED }
  }
  if (response.status !== 201) {
    return { ok: false, error: statusError(response.status) }
  }

  let parsed: unknown
  try {
    parsed = (await response.json()) as unknown
  } catch {
    return { ok: false, error: UNEXPECTED_BODY }
  }
  if (!isReceipt(parsed)) return { ok: false, error: UNEXPECTED_BODY }
  return { ok: true, receipt: parsed }
}
