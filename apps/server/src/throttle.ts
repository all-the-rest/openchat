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
  /**
   * Addresses tracked at once. Defaults to `MAX_TRACKED_ADDRESSES`; tests
   * shrink it so eviction is observable without a thousand requests.
   */
  maxAddresses?: number
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
/**
 * Addresses one throttle tracks at once. A self-hosted deployment sees a
 * handful of clients; the cap only exists so a spoofed forwarding header
 * behind a misconfigured proxy cannot grow the map without bound.
 */
export const MAX_TRACKED_ADDRESSES = 1024
const DEFAULT_VERIFICATION_PERMITS = 2

export class FixedWindowThrottle {
  private readonly buckets = new Map<string, Bucket>()
  private readonly limit: number
  private readonly windowMs: number
  private readonly now: () => number
  private readonly maxAddresses: number

  constructor(options: ThrottleOptions = {}) {
    this.limit = options.limit ?? DEFAULT_LIMIT
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
    this.now = options.now ?? (() => Date.now())
    this.maxAddresses = options.maxAddresses ?? MAX_TRACKED_ADDRESSES
    if (!Number.isInteger(this.maxAddresses) || this.maxAddresses < 1) {
      throw new Error("FixedWindowThrottle needs room for at least one address")
    }
  }

  /** Addresses currently tracked; exposed for tests. */
  get tracked(): number {
    return this.buckets.size
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
      this.makeRoom()
      this.buckets.set(address, { events: 1, resetAt: this.now() + this.windowMs })
      return
    }
    bucket.events += 1
  }

  /** Clears the bucket, e.g. after a successful login. */
  reset(address: string): void {
    this.buckets.delete(address)
  }

  /**
   * Reads a live bucket and marks it as recently used. `Map` keeps insertion
   * order, so delete-and-reinsert turns the map into a cheap LRU list: the
   * first key is the least recently used address.
   */
  private activeBucket(address: string): Bucket | undefined {
    const bucket = this.buckets.get(address)
    if (!bucket) return undefined
    if (this.now() >= bucket.resetAt) {
      this.buckets.delete(address)
      return undefined
    }
    this.buckets.delete(address)
    this.buckets.set(address, bucket)
    return bucket
  }

  /**
   * Frees one slot before a new address is inserted: expired windows go first,
   * then the least recently used address. Deterministic and clock-independent
   * apart from the injected clock, so a spoofed address cannot grow the map.
   */
  private makeRoom(): void {
    if (this.buckets.size < this.maxAddresses) return
    const now = this.now()
    for (const [address, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(address)
    }
    while (this.buckets.size >= this.maxAddresses) {
      const oldest = this.buckets.keys().next()
      if (oldest.done) return
      this.buckets.delete(oldest.value)
    }
  }
}

/**
 * Caps concurrent password verifications. bcryptjs runs in this process, so a
 * burst from many addresses can occupy the only BFF even when every address
 * stays inside its own budget. The permit is a plain counter because the check
 * and the acquisition happen in the same synchronous step; callers release it
 * in a `finally` so a wrong password, a malformed hash that throws, or a failed
 * verification cannot leak capacity.
 *
 * Two permits are enough to let a login and a retry overlap without queueing
 * inside bcrypt; everything beyond answers 429 instead of waiting.
 */
export class VerificationGate {
  private active = 0
  private readonly permits: number

  constructor(permits = DEFAULT_VERIFICATION_PERMITS) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error("VerificationGate needs at least one permit")
    }
    this.permits = permits
  }

  /** Takes one permit; `false` means the caller must answer 429. */
  tryAcquire(): boolean {
    if (this.active >= this.permits) return false
    this.active += 1
    return true
  }

  release(): void {
    if (this.active > 0) this.active -= 1
  }

  /** In-flight verifications; exposed for tests. */
  get inFlight(): number {
    return this.active
  }
}
