/**
 * Server-owned fallback observation.
 *
 * The fallback engine must see every session's events even when no browser is
 * attached: a turn that finishes after the tab closed still needs its ledger
 * row and its one retry. `start` opens exactly one host subscription at boot,
 * feeds the engine, and fans the resulting stream out to the SSE route. A
 * dropped host stream is logged once and retried; `warn` never receives a
 * prompt, a model id or a path, only a fixed message.
 */
import type { EventEnvelope } from "@openchat/contracts"
import { EVENT } from "@openchat/contracts"
import type { ChatBackend } from "@openchat/opencode"

import type { FallbackEngine } from "./fallback-engine"

/** Reconnect delay after the host stream ends or fails. */
export const FALLBACK_RECONNECT_MS = 1000

/** One queued subscriber may buffer this many events before it is closed. */
const SUBSCRIBER_BUFFER_LIMIT = 256

/** Bounded single-consumer queue; an overflowing browser reconnects like SSE. */
class SubscriberQueue implements AsyncIterable<EventEnvelope> {
  private values: EventEnvelope[] = []
  private waiters: Array<(result: IteratorResult<EventEnvelope>) => void> = []
  private closed = false
  private cleanup: (() => void) | undefined

  onCleanup(cleanup: () => void): void {
    this.cleanup = cleanup
  }

  push(value: EventEnvelope): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ value, done: false })
      return
    }
    if (this.values.length >= SUBSCRIBER_BUFFER_LIMIT) {
      this.close()
      return
    }
    this.values.push(value)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.values.length = 0
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
    const cleanup = this.cleanup
    this.cleanup = undefined
    cleanup?.()
  }

  [Symbol.asyncIterator](): AsyncIterator<EventEnvelope> {
    return {
      next: () => this.next(),
      return: async () => {
        this.close()
        return { value: undefined, done: true }
      },
    }
  }

  private next(): Promise<IteratorResult<EventEnvelope>> {
    const value = this.values.shift()
    if (value !== undefined) return Promise.resolve({ value, done: false })
    if (this.closed) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve) => this.waiters.push(resolve))
  }
}

function sessionIDOf(event: EventEnvelope): string | undefined {
  const value = event.data.sessionID
  return typeof value === "string" ? value : undefined
}

export interface FallbackObserverDeps {
  backend: Pick<ChatBackend, "subscribe">
  engine: Pick<FallbackEngine, "observe" | "onFailure" | "onSuccess" | "forget">
  /** Boot/log sink; defaults to the server's `console.warn` prefix. */
  warn?: (message: string) => void
  /** Injectable reconnect delay; tests shorten it. */
  reconnectMs?: number
}

export class FallbackObserver {
  private readonly deps: FallbackObserverDeps
  private readonly warn: (message: string) => void
  private readonly reconnectMs: number
  private readonly subscribers = new Set<SubscriberQueue>()
  /** Events held per session while its failure is being decided. */
  private readonly held = new Map<string, EventEnvelope[]>()
  private started = false
  private stopped = false
  private controller?: AbortController
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private wakeReconnect?: () => void

  constructor(deps: FallbackObserverDeps) {
    this.deps = deps
    this.warn = deps.warn ?? ((message) => console.warn(`[openchat] ${message}`))
    this.reconnectMs = deps.reconnectMs ?? FALLBACK_RECONNECT_MS
  }

  /** Opens the one server-side host subscription. Calling twice is a no-op. */
  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    void this.run()
  }

  stop(): void {
    this.stopped = true
    this.controller?.abort()
    this.controller = undefined
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.wakeReconnect?.()
    this.wakeReconnect = undefined
    for (const subscriber of this.subscribers) subscriber.close()
    this.subscribers.clear()
    this.held.clear()
  }

  /** Browser-facing stream: host events after the engine's transformations. */
  subscribe(signal?: AbortSignal): AsyncIterable<EventEnvelope> {
    const queue = new SubscriberQueue()
    if (signal?.aborted) {
      queue.close()
      return queue
    }
    this.subscribers.add(queue)
    queue.onCleanup(() => this.subscribers.delete(queue))
    signal?.addEventListener("abort", () => queue.close(), { once: true })
    return queue
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const controller = new AbortController()
      this.controller = controller
      let failed = false
      try {
        for await (const event of this.deps.backend.subscribe(controller.signal)) {
          if (this.stopped) return
          this.handle(event)
        }
      } catch {
        failed = true
      }
      this.controller = undefined
      if (this.stopped) return
      this.warn(
        failed
          ? "fallback event stream failed; reconnecting"
          : "fallback event stream ended; reconnecting",
      )
      await this.waitForReconnect()
    }
  }

  /**
   * Feeds one host event to the engine. Failure handling runs off the shared
   * loop: a slow ledger scan or retry submit holds only that session's later
   * events, never every browser's stream.
   */
  private handle(event: EventEnvelope): void {
    const sessionID = sessionIDOf(event)
    const pending = sessionID === undefined ? undefined : this.held.get(sessionID)
    if (pending !== undefined) {
      pending.push(event)
      return
    }

    this.deps.engine.observe(event)
    if (event.type === EVENT.interrupted) {
      if (sessionID !== undefined) this.deps.engine.forget(sessionID)
      this.publish(event)
      return
    }
    if (event.type === EVENT.executionFailed) {
      this.dispatchFailure(event, sessionID)
      return
    }
    this.publish(event)
    if (event.type === EVENT.executionSucceeded) this.dispatchSuccess(event)
  }

  private dispatchFailure(event: EventEnvelope, sessionID: string | undefined): void {
    if (sessionID === undefined) {
      this.publish(event)
      return
    }
    this.held.set(sessionID, [])
    void this.deps.engine
      .onFailure(event)
      .then((result) => {
        for (const synthetic of result.events as EventEnvelope[]) this.publish(synthetic)
        // A taken retry and a duplicate report both stay silent; the original
        // failure is only forwarded when no retry was possible.
        if (!result.suppress) this.publish(event)
      })
      .catch(() => {
        this.warn("fallback retry failed; forwarded the original failure")
        this.publish(event)
      })
      .finally(() => {
        const buffered = this.held.get(sessionID)
        this.held.delete(sessionID)
        if (buffered === undefined) return
        for (const next of buffered) this.handle(next)
      })
  }

  private dispatchSuccess(event: EventEnvelope): void {
    void this.deps.engine
      .onSuccess(event)
      .then((events) => {
        for (const synthetic of events as EventEnvelope[]) this.publish(synthetic)
      })
      .catch(() => {
        this.warn("fallback outcome could not be recorded")
      })
  }

  private publish(event: EventEnvelope): void {
    for (const subscriber of this.subscribers) subscriber.push(event)
  }

  private waitForReconnect(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return new Promise((resolve) => {
      this.wakeReconnect = resolve
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined
        this.wakeReconnect = undefined
        resolve()
      }, this.reconnectMs)
    })
  }
}
