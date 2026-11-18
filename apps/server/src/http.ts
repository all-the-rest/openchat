import type { Context } from "hono"
import { MAX_BODY_BYTES, isBodyTooLarge } from "./limits"

export function jsonError(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 502 | 503 | 504,
  code: string,
  message: string,
): Response {
  return c.json({ error: { code, message } }, status)
}

export const INVALID_JSON = Symbol("invalid-json")
export const BODY_TOO_LARGE = Symbol("body-too-large")

export function payloadTooLarge(c: Context): Response {
  return jsonError(
    c,
    413,
    "payload_too_large",
    `Request body must not exceed ${MAX_BODY_BYTES} bytes`,
  )
}

export async function readJson(c: Context): Promise<unknown> {
  const buffer = await c.req.arrayBuffer()
  if (isBodyTooLarge(buffer)) return BODY_TOO_LARGE
  const text = new TextDecoder().decode(buffer)
  if (text.trim() === "") return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return INVALID_JSON
  }
}

export function invalidMessage(error: {
  issues: Array<{ message?: string }>
}): string {
  return error.issues[0]?.message ?? "Invalid request body"
}
