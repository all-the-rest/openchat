/**
 * In-memory fixed-window throttle. Single-user self-hosted BFF, so a Map is
 * enough and no state needs to survive a restart.
 *
 * The window is fixed: the first recorded event opens a `windowMs` window,
 * every further event inside it counts, and the window resets afterwards.
 * Login uses it for failures (a success clears the bucket), prompts use it for
 * accepted submissions.
 */
export interface ThrottleOptions {
  /** Events allowed inside one window. Defaults to 10. */
  limit?: number
  /** Window length in milliseconds. Defaults to 60 seconds. */
  windowMs?: number
  /** Injected clock for tests. */
  now?: () => number
}

export interface ThrottleStatus {
  limited: boolean
  /** Whole seconds until the window resets; at least 1 when limited. */
  retryAfterSeconds: number
}

interface Bucket {
  events: number
  resetAt: number
}

const DEFAULT_LIMIT = 10
const DEFAULT_WINDOW_MS = 60_000
const MAX_TRACKED_ADDRESSES = 1024

export class FixedWindowThrottle {
  private readonly buckets = new Map<string, Bucket>()
  private readonly limit: number
  private readonly windowMs: number
  private readonly now: () => number

  constructor(options: ThrottleOptions = {}) {
    this.limit = options.limit ?? DEFAULT_LIMIT
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
    this.now = options.now ?? (() => Date.now())
  }

  check(address: string): ThrottleStatus {
    const bucket = this.activeBucket(address)
    if (!bucket || bucket.events < this.limit) {
      return { limited: false, retryAfterSeconds: 0 }
    }
    return {
      limited: true,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - this.now()) / 1000)),
    }
  }

  /** Counts one event and opens the window on the first one. */
  record(address: string): void {
    const bucket = this.activeBucket(address)
    if (!bucket) {
      this.prune()
      this.buckets.set(address, { events: 1, resetAt: this.now() + this.windowMs })
      return
    }
    bucket.events += 1
  }

  /** Clears the bucket, e.g. after a successful login. */
  reset(address: string): void {
    this.buckets.delete(address)
  }

  private activeBucket(address: string): Bucket | undefined {
    const bucket = this.buckets.get(address)
    if (!bucket) return undefined
    if (this.now() >= bucket.resetAt) {
      this.buckets.delete(address)
      return undefined
    }
    return bucket
  }

  private prune(): void {
    if (this.buckets.size < MAX_TRACKED_ADDRESSES) return
    const now = this.now()
    for (const [address, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(address)
    }
  }
}
