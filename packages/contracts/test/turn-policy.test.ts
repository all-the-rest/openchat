import { describe, expect, it } from "vitest"
import { MAX_CHAIN_LENGTH, turnPolicySchema } from "../src/turn-policy"

function model(providerID: string, modelID: string, extra: Record<string, unknown> = {}) {
  return { providerID, modelID, ...extra }
}

function policy(overrides: Record<string, unknown> = {}) {
  return {
    surface: "chat",
    chain: [model("opencode", "free-1", { isFree: true })],
    paidDailyCap: 0,
    contextSoftCap: 0,
    ...overrides,
  }
}

function accepted(overrides: Record<string, unknown> = {}): boolean {
  return turnPolicySchema.safeParse(policy(overrides)).success
}

describe("turn policy schema", () => {
  it("accepts a chat chain with both caps off", () => {
    expect(accepted()).toBe(true)
  })

  it("accepts a code policy with no chain and no caps", () => {
    expect(accepted({ surface: "code", chain: [] })).toBe(true)
  })

  it(`accepts ${MAX_CHAIN_LENGTH} entries and rejects ${MAX_CHAIN_LENGTH + 1}`, () => {
    const entries = Array.from({ length: MAX_CHAIN_LENGTH }, (_value, index) =>
      model("provider", `model-${index}`),
    )
    expect(accepted({ chain: entries })).toBe(true)
    expect(accepted({ chain: [...entries, model("provider", "model-extra")] })).toBe(false)
  })

  it("accepts integer caps at zero and above", () => {
    expect(accepted({ paidDailyCap: 250_000, contextSoftCap: 128_000 })).toBe(true)
  })

  it.each([
    ["negative paid cap", { paidDailyCap: -1 }],
    ["fractional paid cap", { paidDailyCap: 1.5 }],
    ["negative context cap", { contextSoftCap: -1 }],
    ["fractional context cap", { contextSoftCap: 0.5 }],
  ])("rejects %s", (_label, overrides) => {
    expect(accepted(overrides)).toBe(false)
  })

  it("rejects an unknown surface", () => {
    expect(accepted({ surface: "terminal" })).toBe(false)
  })

  it.each([
    ["empty provider", { providerID: "" }],
    ["whitespace provider", { providerID: "   " }],
    ["empty model", { modelID: "" }],
    ["empty variant", { variant: "" }],
  ])("rejects an %s", (_label, extra) => {
    expect(accepted({ chain: [model("provider", "model", extra)] })).toBe(false)
  })

  it("rejects the same provider and model twice", () => {
    expect(
      accepted({
        chain: [model("opencode", "free-1"), model("opencode", "free-1", { isFree: true })],
      }),
    ).toBe(false)
  })

  it("rejects a duplicate that differs only in the free flag", () => {
    expect(
      accepted({
        chain: [
          model("opencode", "free-1", { isFree: true }),
          model("opencode", "free-1", { isFree: false }),
        ],
      }),
    ).toBe(false)
  })

  it("accepts the same model with a different variant", () => {
    expect(
      accepted({
        chain: [model("provider", "model", { variant: "fast" }), model("provider", "model", { variant: "deep" })],
      }),
    ).toBe(true)
  })
})
