import type {
  CompactionOutcome,
  EventEnvelope,
  SessionContext,
  TokenUsage,
} from "@openchat/contracts"
import type { OpenCodeClient } from "@opencode/client"
import type { CompactOptions } from "./index"
import { BackendError } from "./errors"

interface TaggedError {
  _tag?: unknown
}

function errorTag(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const tag = (error as TaggedError)._tag
  return typeof tag === "string" ? tag : undefined
}

/** Maps a host rejection without forwarding the upstream message. */
export function mapCompactionError(error: unknown): BackendError {
  const tag = errorTag(error)
  if (tag === "SessionNotFoundError") {
    return new BackendError("not_found", "The session does not exist on the host")
  }
  if (tag === "ConflictError") {
    return new BackendError("conflict", "The session is busy; compaction was not started")
  }
  if (tag === "InvalidRequestError") {
    return new BackendError("invalid", "The host rejected the compaction request")
  }
  return new BackendError("unavailable", "The host did not answer the compaction request")
}

/** The host's token usage in the contract shape, or `null` for garbage. */
export function normalizeUsage(tokens: unknown): TokenUsage | null {
  if (tokens === null || typeof tokens !== "object") return null
  const record = tokens as Record<string, unknown>
  const cache = record.cache
  if (cache === null || typeof cache !== "object") return null
  const cacheRecord = cache as Record<string, unknown>
  const values = [
    record.input,
    record.output,
    record.reasoning,
    cacheRecord.read,
    cacheRecord.write,
  ]
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    return null
  }
  return {
    input: record.input as number,
    output: record.output as number,
    reasoning: record.reasoning as number,
    cache: { read: cacheRecord.read as number, write: cacheRecord.write as number },
  }
}

/**
 * Session token accounting from one message read. The last assistant turn that
 * reported tokens wins; a turn without a completion time is still streaming.
 */
export async function sessionContextOnHost(
  client: OpenCodeClient,
  sessionID: string,
): Promise<SessionContext> {
  const response = await client.message.list({ sessionID })
  let usage: TokenUsage | null = null
  let streaming = false
  for (const info of response.data) {
    if (info.type !== "assistant") continue
    const reported = normalizeUsage(info.tokens)
    if (reported) usage = reported
    if (info.time.completed === undefined && info.error === undefined) streaming = true
  }
  return { usage, streaming }
}

interface Terminal {
  status: "ended" | "failed"
  summary?: string
  error?: string
}

function failureMessage(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined
  const message = (error as Record<string, unknown>).message
  return typeof message === "string" ? message : undefined
}

/** Waits for the session's terminal compaction event; `null` when the stream ends. */
async function readTerminal(
  iterator: AsyncIterator<EventEnvelope>,
  sessionID: string,
): Promise<Terminal | null> {
  while (true) {
    const next = await iterator.next()
    if (next.done) return null
    const event = next.value
    if (event.data.sessionID !== sessionID) continue
    if (event.type === "session.compaction.ended") {
      const text = event.data.text
      return { status: "ended", summary: typeof text === "string" ? text : undefined }
    }
    if (event.type === "session.compaction.failed") {
      return { status: "failed", error: failureMessage(event.data.error) }
    }
  }
}

async function waitBounded(
  terminal: Promise<Terminal | null>,
  timeoutMs: number,
): Promise<CompactionOutcome | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })
  try {
    const outcome = await Promise.race([terminal, timeout])
    return outcome
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Requests one host compaction and, when asked, waits for its terminal event.
 * The event subscription starts before the request so the terminal event
 * cannot be missed between the call and the wait.
 */
export async function compactOnHost(
  client: OpenCodeClient,
  subscribe: (signal?: AbortSignal) => AsyncIterable<EventEnvelope>,
  sessionID: string,
  options: CompactOptions = {},
): Promise<CompactionOutcome> {
  const waitMs = options.waitMs ?? 0
  if (waitMs <= 0) {
    try {
      const entry = await client.session.compact({
        sessionID,
        ...(options.id === undefined ? {} : { id: options.id }),
      })
      return { status: "accepted", id: entry.id }
    } catch (error) {
      throw mapCompactionError(error)
    }
  }

  const controller = new AbortController()
  const iterator = subscribe(controller.signal)[Symbol.asyncIterator]()
  const terminal = readTerminal(iterator, sessionID)
  try {
    const entry = await client.session.compact({
      sessionID,
      ...(options.id === undefined ? {} : { id: options.id }),
    })
    const outcome = await waitBounded(terminal, waitMs)
    if (!outcome) return { status: "timeout", id: entry.id }
    return { ...outcome, id: entry.id }
  } catch (error) {
    throw mapCompactionError(error)
  } finally {
    controller.abort()
    await iterator.return?.().catch(() => undefined)
  }
}
