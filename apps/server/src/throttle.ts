/**
 * In-memory failed-login throttle. Single-user self-hosted BFF, so a Map is
 * enough and no state needs to survive a restart.
 *
 * The window is fixed: the first failure opens a `windowMs` window, every
 * further failure inside it counts, and a successful login clears the bucket.
 */
export interface LoginThrottleOptions {
  /** Failed attempts allowed inside one window. Defaults to 10. */
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
  failures: number
  resetAt: number
}

const DEFAULT_LIMIT = 10
const DEFAULT_WINDOW_MS = 60_000
const MAX_TRACKED_ADDRESSES = 1024

export class LoginThrottle {
  private readonly buckets = new Map<string, Bucket>()
  private readonly limit: number
  private readonly windowMs: number
  private readonly now: () => number

  constructor(options: LoginThrottleOptions = {}) {
    this.limit = options.limit ?? DEFAULT_LIMIT
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
    this.now = options.now ?? (() => Date.now())
  }

  check(address: string): ThrottleStatus {
    const bucket = this.activeBucket(address)
    if (!bucket || bucket.failures < this.limit) {
      return { limited: false, retryAfterSeconds: 0 }
    }
    return {
      limited: true,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - this.now()) / 1000)),
    }
  }

  recordFailure(address: string): void {
    const bucket = this.activeBucket(address)
    if (!bucket) {
      this.prune()
      this.buckets.set(address, { failures: 1, resetAt: this.now() + this.windowMs })
      return
    }
    bucket.failures += 1
  }

  recordSuccess(address: string): void {
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
