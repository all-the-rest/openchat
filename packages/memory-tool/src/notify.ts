/**
 * The one HTTP call the tool makes: tell the BFF that memory changed so it can
 * refresh the instruction entries of active sessions. The notification is best
 * effort: an unreachable or rejecting BFF never fails the write that succeeded
 * locally. No response body or token is returned to the model.
 */
export const NOTIFY_PATH = "/internal/memory/changed"

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface NotifyOptions {
  bffUrl: string
  token: string
  fetch?: FetchLike
}

export function notifyUrl(bffUrl: string): string {
  return `${bffUrl.replace(/\/+$/, "")}${NOTIFY_PATH}`
}

/** True only when both halves of the secret configuration are present. */
export function notifyConfigured(options: NotifyOptions): boolean {
  return options.bffUrl.length > 0 && options.token.length > 0
}

export async function notifyChanged(options: NotifyOptions): Promise<boolean> {
  if (!notifyConfigured(options)) return false
  const fetchImpl = options.fetch ?? globalThis.fetch
  try {
    const response = await fetchImpl(notifyUrl(options.bffUrl), {
      method: "POST",
      redirect: "manual",
      credentials: "omit",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${options.token}`,
      },
      body: "{}",
    })
    return response.status >= 200 && response.status < 300
  } catch {
    return false
  }
}
