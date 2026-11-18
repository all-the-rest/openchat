/**
 * Process-local single-use cache for ticket `jti` values.
 *
 * Entries expire at the ticket's own `exp`, so the cache can never outlive the
 * window in which a ticket would verify. The entry count is bounded: tickets
 * are minted by the app (not by the internet), and dropping the oldest entry
 * is preferable to failing a legitimate sign-in when the bound is reached.
 *
 * A second Code host process has its own cache; the deployment runs one.
 */
export const MAX_REPLAY_ENTRIES = 10_000

export class TicketReplayCache {
  private readonly entries = new Map<string, number>()
  private readonly maxEntries: number

  constructor(maxEntries = MAX_REPLAY_ENTRIES) {
    this.maxEntries = Math.max(1, maxEntries)
  }

  get size(): number {
    return this.entries.size
  }

  /**
   * Records a redemption. Returns `false` when the `jti` was already claimed.
   * `exp` is epoch seconds and `now` epoch milliseconds, like the ticket.
   */
  claim(jti: string, exp: number, now = Date.now()): boolean {
    if (!jti) return false
    this.prune(now)
    if (this.entries.has(jti)) return false
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (!oldest.done) this.entries.delete(oldest.value)
    }
    this.entries.set(jti, exp)
    return true
  }

  private prune(now: number): void {
    const nowSeconds = Math.floor(now / 1000)
    for (const [jti, exp] of this.entries) {
      if (exp <= nowSeconds) this.entries.delete(jti)
    }
  }
}
