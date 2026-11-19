/**
 * Turns a deployment's fallback settings into a validated `TurnPolicy`. Pure:
 * no config files, no environment, no I/O. The authoritative schema and model
 * identity helpers live in `@openchat/contracts`; this module only assembles
 * them and gives callers a clear error when an admin-supplied chain is invalid.
 */
import type { ModelRef, TurnPolicy } from "@openchat/contracts"
import {
  MAX_CHAIN_LENGTH,
  modelKey,
  modelRefSchema,
  turnPolicySchema,
} from "@openchat/contracts"

import { nextModel } from "./fallback-policy"

/** The Code surface never falls back: its chain stays empty and caps are off. */
export const CODE_POLICY: TurnPolicy = {
  surface: "code",
  chain: [],
  paidDailyCap: 0,
  contextSoftCap: 0,
}

export interface ChatPolicyInput {
  chain: ModelRef[]
  paidDailyCap: number
  contextSoftCap: number
}

/**
 * Builds a chat policy, validating the caps, the chain length and duplicate
 * entries through `turnPolicySchema`. Throws a readable error instead of
 * letting a malformed setting fail deep inside the fallback engine.
 */
export function resolveChatPolicy(input: ChatPolicyInput): TurnPolicy {
  const candidate = {
    surface: "chat" as const,
    chain: input.chain,
    paidDailyCap: input.paidDailyCap,
    contextSoftCap: input.contextSoftCap,
  }
  const parsed = turnPolicySchema.safeParse(candidate)
  if (!parsed.success) {
    throw new Error(`Invalid chat fallback policy: ${parsed.error.message}`)
  }
  return parsed.data
}

/** The first candidate a chat turn should request. */
export function requestedModel(policy: TurnPolicy): ModelRef | undefined {
  return nextModel(policy, [])
}

/**
 * Parses an admin-supplied JSON array of models into a validated chain. Each
 * entry goes through the shared `modelRefSchema`; length and duplicates are
 * checked here so callers get one clear error for the whole setting.
 */
export function validateChainJson(raw: string): ModelRef[] {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error("Fallback chain must be valid JSON")
  }
  if (!Array.isArray(value)) {
    throw new Error("Fallback chain must be a JSON array")
  }
  if (value.length > MAX_CHAIN_LENGTH) {
    throw new Error(
      `Fallback chain has ${value.length} entries; at most ${MAX_CHAIN_LENGTH} are allowed`,
    )
  }

  const seen = new Set<string>()
  const chain: ModelRef[] = []
  for (const [index, entry] of value.entries()) {
    const parsed = modelRefSchema.safeParse(entry)
    if (!parsed.success) {
      throw new Error(`Fallback chain entry ${index} is invalid: ${parsed.error.message}`)
    }
    const key = modelKey(parsed.data)
    if (seen.has(key)) {
      throw new Error(
        `Duplicate model in fallback chain: ${parsed.data.providerID}/${parsed.data.modelID}`,
      )
    }
    seen.add(key)
    chain.push(parsed.data)
  }
  return chain
}
