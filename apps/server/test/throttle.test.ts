import { describe, expect, it } from "vitest"
import { FixedWindowThrottle, MAX_TRACKED_ADDRESSES } from "../src/throttle"

function address(index: number): string {
  return `198.51.100.${index}`
}

describe("FixedWindowThrottle address cap", () => {
  it("tracks at most the configured number of addresses", () => {
    const throttle = new FixedWindowThrottle({
      limit: 2,
      windowMs: 1_000,
      now: () => 0,
      maxAddresses: 3,
    })

    for (let index = 1; index <= 20; index += 1) {
      throttle.record(address(index))
      expect(throttle.tracked).toBeLessThanOrEqual(3)
    }
    expect(throttle.tracked).toBe(3)
  })

  it("defaults the cap to MAX_TRACKED_ADDRESSES", () => {
    const throttle = new FixedWindowThrottle({ now: () => 0 })
    for (let index = 0; index < MAX_TRACKED_ADDRESSES; index += 1) {
      throttle.record(`addr-${index}`)
    }
    expect(throttle.tracked).toBe(MAX_TRACKED_ADDRESSES)

    throttle.record("one-more")
    expect(throttle.tracked).toBe(MAX_TRACKED_ADDRESSES)
  })

  it("keeps the window of a tracked address when another one is evicted", () => {
    const throttle = new FixedWindowThrottle({
      limit: 3,
      windowMs: 1_000,
      now: () => 0,
      maxAddresses: 2,
    })

    throttle.record(address(1))
    throttle.record(address(2))
    // A second event makes address 1 the most recently used one.
    throttle.record(address(1))

    // Address 2 is the least recently used entry and makes room for address 3.
    throttle.record(address(3))
    expect(throttle.tracked).toBe(2)

    // Address 1 still counts two events; address 2 starts a fresh window.
    expect(throttle.check(address(1)).limited).toBe(false)
    throttle.record(address(1))
    expect(throttle.check(address(1)).limited).toBe(true)
    expect(throttle.check(address(2)).limited).toBe(false)
  })

  it("evicts an expired window before a live least-recently used one", () => {
    let now = 0
    const throttle = new FixedWindowThrottle({
      limit: 2,
      windowMs: 1_000,
      now: () => now,
      maxAddresses: 2,
    })

    throttle.record(address(1))
    now = 1_500
    throttle.record(address(2))
    expect(throttle.tracked).toBe(2)

    // Address 1 expired at 1_000, so it goes first even though address 2 would
    // be the least recently used entry by insertion order alone.
    throttle.record(address(3))
    expect(throttle.tracked).toBe(2)
    throttle.record(address(2))
    expect(throttle.check(address(2)).limited).toBe(true)
    expect(throttle.check(address(3)).limited).toBe(false)
  })

  it("refuses a cap that cannot hold one address", () => {
    expect(() => new FixedWindowThrottle({ maxAddresses: 0 })).toThrow()
    expect(() => new FixedWindowThrottle({ maxAddresses: 1.5 })).toThrow()
  })
})
