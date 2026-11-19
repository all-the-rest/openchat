import type { ModelRef } from "@openchat/contracts"
import { describe, expect, it } from "vitest"

import {
  CODE_POLICY,
  requestedModel,
  resolveChatPolicy,
  validateChainJson,
} from "../src/fallback-config"

const A: ModelRef = { providerID: "acme", modelID: "a" }
const B: ModelRef = { providerID: "acme", modelID: "b", variant: "think" }
const FREE: ModelRef = { providerID: "acme", modelID: "free", isFree: true }

function many(count: number): ModelRef[] {
  return Array.from({ length: count }, (_, index) => ({
    providerID: "acme",
    modelID: `m${index}`,
  }))
}

describe("fallback-config", () => {
  it("exposes an inert Code policy", () => {
    expect(CODE_POLICY).toEqual({
      surface: "code",
      chain: [],
      paidDailyCap: 0,
      contextSoftCap: 0,
    })
  })

  it("returns the first chain entry as the requested model", () => {
    expect(requestedModel({ ...CODE_POLICY, chain: [A, B] })).toEqual(A)
    expect(requestedModel(CODE_POLICY)).toBeUndefined()
  })

  it("builds a validated chat policy", () => {
    const policy = resolveChatPolicy({
      chain: [A, B, FREE],
      paidDailyCap: 1000,
      contextSoftCap: 2000,
    })
    expect(policy).toEqual({
      surface: "chat",
      chain: [A, B, FREE],
      paidDailyCap: 1000,
      contextSoftCap: 2000,
    })
  })

  const invalid: Array<[string, Parameters<typeof resolveChatPolicy>[0], RegExp]> = [
    ["negative paid cap", { chain: [A], paidDailyCap: -1, contextSoftCap: 0 }, /invalid chat fallback policy/i],
    ["negative context cap", { chain: [A], paidDailyCap: 0, contextSoftCap: -1 }, /invalid chat fallback policy/i],
    ["chain over five", { chain: many(6), paidDailyCap: 0, contextSoftCap: 0 }, /invalid chat fallback policy/i],
    ["duplicate model", { chain: [A, A], paidDailyCap: 0, contextSoftCap: 0 }, /duplicate/i],
  ]
  it.each(invalid)("rejects %s", (_name, input, pattern) => {
    expect(() => resolveChatPolicy(input)).toThrow(pattern)
  })

  it("accepts a valid JSON chain with optional fields", () => {
    expect(validateChainJson(JSON.stringify([A, B, FREE]))).toEqual([A, B, FREE])
  })

  it("accepts an empty JSON chain", () => {
    expect(validateChainJson("[]")).toEqual([])
  })

  it("rejects a duplicate model in a JSON chain", () => {
    expect(() => validateChainJson(JSON.stringify([A, A]))).toThrow(/duplicate/i)
  })

  it("rejects a JSON chain over five entries", () => {
    expect(() => validateChainJson(JSON.stringify(many(6)))).toThrow(/at most 5/i)
  })

  it.each(["{not json", '"a string"', '{}'])("rejects malformed or non-array input %s", (raw) => {
    expect(() => validateChainJson(raw)).toThrow()
  })

  it("rejects an invalid chain entry", () => {
    expect(() => validateChainJson(JSON.stringify([{ providerID: "", modelID: "x" }]))).toThrow(
      /entry 0 is invalid/i,
    )
  })
})
