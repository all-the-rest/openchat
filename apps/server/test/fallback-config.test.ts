import type { ModelRef, TurnPolicy } from "@openchat/contracts"
import { describe, expect, it } from "vitest"

import {
  clientModelRef,
  requestedModel,
  resolveChatPolicy,
  validateChainJson,
} from "../src/fallback-config"

const A: ModelRef = { providerID: "acme", modelID: "a" }
const B: ModelRef = { providerID: "acme", modelID: "b", variant: "think" }
const FREE: ModelRef = { providerID: "acme", modelID: "free", isFree: true }

function chatPolicy(chain: ModelRef[]): TurnPolicy {
  return { surface: "chat", chain, paidDailyTurns: 0, contextSoftCap: 0 }
}

function many(count: number): ModelRef[] {
  return Array.from({ length: count }, (_, index) => ({
    providerID: "acme",
    modelID: `m${index}`,
  }))
}

describe("fallback-config", () => {
  it("returns the first chain entry as the requested model", () => {
    expect(requestedModel(chatPolicy([A, B]))).toEqual(A)
    expect(requestedModel(chatPolicy([]))).toBeUndefined()
  })

  it("builds a validated chat policy", () => {
    const policy = resolveChatPolicy({
      chain: [A, B, FREE],
      paidDailyTurns: 1000,
      contextSoftCap: 2000,
    })
    expect(policy).toEqual({
      surface: "chat",
      chain: [A, B, FREE],
      paidDailyTurns: 1000,
      contextSoftCap: 2000,
    })
  })

  it("turns the browser's model and variant into the first requested ref", () => {
    expect(clientModelRef("opencode/free-1", "think")).toEqual({
      providerID: "opencode",
      modelID: "free-1",
      variant: "think",
    })
    // A model id that itself contains a slash keeps it.
    expect(clientModelRef("openrouter/anthropic/claude")).toEqual({
      providerID: "openrouter",
      modelID: "anthropic/claude",
    })
    expect(clientModelRef(undefined)).toBeUndefined()
  })

  it("resolves a catalogue id before splitting it on a slash", () => {
    const catalogue = [
      { id: "fake/echo", providerID: "fake", variants: ["fast"], contextLimit: 128_000 },
      { id: "echo", providerID: "echo", variants: [] },
    ]
    expect(clientModelRef("fake/echo", "fast", catalogue)).toEqual({
      providerID: "fake",
      modelID: "fake/echo",
      variant: "fast",
      contextLimit: 128_000,
    })
    // A variant the catalogue no longer offers is dropped.
    expect(clientModelRef("fake/echo", "gone", catalogue)).toEqual({
      providerID: "fake",
      modelID: "fake/echo",
      contextLimit: 128_000,
    })
    expect(clientModelRef("echo", undefined, catalogue)).toEqual({
      providerID: "echo",
      modelID: "echo",
    })
    expect(clientModelRef("unknown/model", undefined, catalogue)).toBeUndefined()
  })

  it.each(["", "noslash", "/model", "provider/"])("ignores the malformed model %j", (model) => {
    expect(clientModelRef(model)).toBeUndefined()
  })

  const invalid: Array<[string, Parameters<typeof resolveChatPolicy>[0], RegExp]> = [
    ["negative paid cap", { chain: [A], paidDailyTurns: -1, contextSoftCap: 0 }, /invalid chat fallback policy/i],
    ["negative context cap", { chain: [A], paidDailyTurns: 0, contextSoftCap: -1 }, /invalid chat fallback policy/i],
    ["chain over five", { chain: many(6), paidDailyTurns: 0, contextSoftCap: 0 }, /invalid chat fallback policy/i],
    ["duplicate model", { chain: [A, A], paidDailyTurns: 0, contextSoftCap: 0 }, /duplicate/i],
  ]
  it.each(invalid)("rejects %s", (_name, input, pattern) => {
    expect(() => resolveChatPolicy(input)).toThrow(pattern)
  })

  it("accepts a valid JSON chain with optional fields", () => {
    expect(validateChainJson(JSON.stringify([A, B, FREE]))).toEqual([A, B, FREE])
  })

  it("accepts an optional context window on a chain entry", () => {
    const withWindow: ModelRef = { ...A, contextLimit: 32_768 }
    expect(validateChainJson(JSON.stringify([withWindow]))).toEqual([withWindow])
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
