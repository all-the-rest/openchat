import { describe, expect, it } from "vitest"
import { MAX_REPLAY_ENTRIES, TicketReplayCache } from "../src/replay"

const NOW = 1_700_000_000_000
const EXP = Math.floor(NOW / 1000) + 30

describe("TicketReplayCache", () => {
  it("accepts the first claim and rejects a repeated jti", () => {
    const cache = new TicketReplayCache()
    expect(cache.claim("one", EXP, NOW)).toBe(true)
    expect(cache.claim("one", EXP, NOW)).toBe(false)
    expect(cache.size).toBe(1)
  })

  it("keeps different jtis independent", () => {
    const cache = new TicketReplayCache()
    expect(cache.claim("one", EXP, NOW)).toBe(true)
    expect(cache.claim("two", EXP, NOW)).toBe(true)
    expect(cache.size).toBe(2)
  })

  it("forgets entries once the ticket expiry has passed", () => {
    const cache = new TicketReplayCache()
    expect(cache.claim("one", EXP, NOW)).toBe(true)
    expect(cache.claim("one", EXP, NOW + 29_000)).toBe(false)
    // At exp the ticket itself no longer verifies; the entry is pruned.
    expect(cache.size).toBe(1)
    cache.claim("fresh", EXP + 60, NOW + 30_000)
    expect(cache.size).toBe(1)
  })

  it("stays bounded by evicting the oldest entry", () => {
    const cache = new TicketReplayCache(2)
    expect(cache.claim("one", EXP, NOW)).toBe(true)
    expect(cache.claim("two", EXP, NOW)).toBe(true)
    expect(cache.claim("three", EXP, NOW)).toBe(true)
    expect(cache.size).toBe(2)
    // "one" was evicted; in a full cache that is preferable to refusing a
    // legitimate sign-in. Tickets are minted by the app, not by the internet.
    expect(cache.claim("one", EXP, NOW)).toBe(true)
    expect(cache.claim("two", EXP, NOW)).toBe(true)
  })

  it("rejects an empty jti", () => {
    const cache = new TicketReplayCache()
    expect(cache.claim("", EXP, NOW)).toBe(false)
  })

  it("has a documented default bound", () => {
    expect(MAX_REPLAY_ENTRIES).toBeGreaterThan(0)
    expect(new TicketReplayCache().claim("one", EXP, NOW)).toBe(true)
  })
})
