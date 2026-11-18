import { describe, expect, it } from "vitest"
import type { ModelRef, TurnPolicy } from "@openchat/contracts"
import {
  classifyFailure,
  isFreeModel,
  isRetryable,
  nextModel,
  shouldFallback,
} from "../src/fallback-policy"
import type { FallbackDecisionInput } from "../src/fallback-policy"

const FREE: ModelRef = { providerID: "opencode", modelID: "free-1", isFree: true }
const PAID: ModelRef = { providerID: "acme", modelID: "large" }

function chatPolicy(overrides: Partial<TurnPolicy> = {}): TurnPolicy {
  return {
    surface: "chat",
    chain: [FREE, PAID],
    paidDailyCap: 5_000,
    contextSoftCap: 0,
    ...overrides,
  }
}

function decision(overrides: Partial<FallbackDecisionInput> = {}): boolean {
  return shouldFallback({
    policy: chatPolicy(),
    failure: { code: "rate_limit" },
    emittedText: "",
    attempts: 1,
    paidSpent: 0,
    next: PAID,
    ...overrides,
  })
}

describe("failure classification", () => {
  it.each([
    ["rate_limit", "rate_limit"],
    ["rate-limit", "rate_limit"],
    ["RATE LIMIT", "rate_limit"],
    ["too_many_requests", "rate_limit"],
    ["429", "rate_limit"],
    ["provider_error", "provider_error"],
    ["server_error", "provider_error"],
    ["500", "provider_error"],
    ["502", "provider_error"],
    ["503", "provider_error"],
    ["upstream_error", "provider_error"],
    ["timeout", "timeout"],
    ["timed_out", "timeout"],
    ["gateway_timeout", "timeout"],
    ["504", "timeout"],
    ["context_overflow", "context_overflow"],
    ["context_length_exceeded", "context_overflow"],
    ["prompt_too_long", "context_overflow"],
    ["auth", "auth"],
    ["invalid_api_key", "auth"],
    ["401", "auth"],
    ["403", "auth"],
    ["not_a_real_code", "unknown"],
    ["", "unknown"],
  ])("classifies code %s as %s", (code, reason) => {
    expect(classifyFailure({ code })).toBe(reason)
  })

  it.each([
    ["Rate limit reached, retry later", "rate_limit"],
    ["Too many requests", "rate_limit"],
    ["The context length exceeded the window", "context_overflow"],
    ["The upstream timed out", "timeout"],
    ["Invalid API key", "auth"],
    ["Internal server error (500)", "provider_error"],
    ["Service unavailable", "provider_error"],
    ["The model produced an empty answer", "unknown"],
  ])("classifies bounded message %j as %s", (message, reason) => {
    expect(classifyFailure({ message })).toBe(reason)
  })

  it("prefers a stable code over a misleading message", () => {
    expect(classifyFailure({ code: "auth", message: "rate limit" })).toBe("auth")
  })

  it("does not scan prose beyond the bounded prefix", () => {
    expect(classifyFailure({ message: `${"x".repeat(200)} rate limit` })).toBe("unknown")
  })

  it("never lets the retryable flag invent a category", () => {
    expect(classifyFailure({ retryable: true })).toBe("unknown")
    expect(classifyFailure({ code: "auth", retryable: true })).toBe("auth")
  })

  it("does not let a false flag erase a stable code", () => {
    expect(classifyFailure({ code: "rate_limit", retryable: false })).toBe("rate_limit")
  })

  it("marks only the four fallback reasons retryable", () => {
    expect(isRetryable("rate_limit")).toBe(true)
    expect(isRetryable("provider_error")).toBe(true)
    expect(isRetryable("timeout")).toBe(true)
    expect(isRetryable("context_overflow")).toBe(true)
    expect(isRetryable("auth")).toBe(false)
    expect(isRetryable("unknown")).toBe(false)
  })
})

describe("one-retry fallback decision", () => {
  it("allows the first retry after a retryable failure", () => {
    expect(decision()).toBe(true)
  })

  it("allows a provider 5xx, timeout and context overflow", () => {
    expect(decision({ failure: { code: "provider_error" } })).toBe(true)
    expect(decision({ failure: { code: "timeout" } })).toBe(true)
    expect(decision({ failure: { code: "context_overflow" } })).toBe(true)
  })

  it.each([
    ["a partial stream", "partial"],
    ["whitespace output", " "],
  ])("refuses to retry after %s", (_label, emittedText) => {
    expect(decision({ emittedText })).toBe(false)
  })

  it("allows exactly one retry per turn", () => {
    expect(decision({ attempts: 2 })).toBe(false)
    expect(decision({ attempts: 3 })).toBe(false)
    expect(decision({ attempts: 0 })).toBe(false)
  })

  it("refuses auth and unknown failures", () => {
    expect(decision({ failure: { code: "auth" } })).toBe(false)
    expect(decision({ failure: { code: "not_a_real_code" } })).toBe(false)
    expect(decision({ failure: { code: "auth", message: "rate limit" } })).toBe(false)
  })

  it("refuses an empty chain even with a candidate", () => {
    expect(decision({ policy: chatPolicy({ chain: [] }) })).toBe(false)
  })

  it("refuses when no next entry exists", () => {
    expect(decision({ next: undefined })).toBe(false)
  })

  it("refuses the code surface", () => {
    expect(decision({ policy: chatPolicy({ surface: "code" }), next: FREE })).toBe(false)
  })

  it("refuses a paid retry once the daily cap is spent", () => {
    expect(decision({ paidSpent: 5_000 })).toBe(false)
    expect(decision({ paidSpent: 6_000 })).toBe(false)
  })

  it("allows a paid retry while budget remains", () => {
    expect(decision({ paidSpent: 4_999 })).toBe(true)
  })

  it("treats a zero cap as off", () => {
    expect(decision({ policy: chatPolicy({ paidDailyCap: 0 }), paidSpent: 1_000_000 })).toBe(true)
  })

  it("lets a free entry bypass an exhausted cap", () => {
    expect(decision({ next: FREE, paidSpent: 1_000_000 })).toBe(true)
  })

  it("does not treat a missing flag as free", () => {
    expect(decision({ next: { providerID: "acme", modelID: "small" }, paidSpent: 5_000 })).toBe(
      false,
    )
  })
})

describe("chain helpers", () => {
  it("returns the first entry that was not tried", () => {
    expect(nextModel(chatPolicy(), [])).toBe(FREE)
    expect(nextModel(chatPolicy(), [FREE])).toBe(PAID)
    expect(nextModel(chatPolicy(), [PAID])).toBe(FREE)
  })

  it("returns undefined when every entry was tried or the chain is empty", () => {
    expect(nextModel(chatPolicy(), [FREE, PAID])).toBeUndefined()
    expect(nextModel(chatPolicy({ chain: [] }), [])).toBeUndefined()
  })

  it("treats variants as different entries", () => {
    const fast: ModelRef = { providerID: "p", modelID: "m", variant: "fast" }
    const deep: ModelRef = { providerID: "p", modelID: "m", variant: "deep" }
    expect(nextModel(chatPolicy({ chain: [fast, deep] }), [fast])).toBe(deep)
  })

  it("only honours an explicit free flag", () => {
    expect(isFreeModel(FREE)).toBe(true)
    expect(isFreeModel(PAID)).toBe(false)
    expect(isFreeModel({ ...PAID, isFree: false })).toBe(false)
  })
})
