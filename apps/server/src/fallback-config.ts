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

export interface ChatPolicyInput {
  chain: ModelRef[]
  paidDailyTurns: number
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
    paidDailyTurns: input.paidDailyTurns,
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
 * A variant survives only while its model's catalogue entry still lists it.
 * Both model-resolution paths use this one rule, so a chain entry cannot
 * forward a variant the catalogue has dropped.
 */
export function offeredVariant(
  variant: string | undefined,
  variants: readonly string[],
): string | undefined {
  return variant !== undefined && variants.includes(variant) ? variant : undefined
}

/**
 * The browser's persisted choice as a full `ModelRef`. Its `model` is a host
 * model id: the catalogue lookup comes first because a model id may itself
 * contain a slash (`fake/echo`). Only when no catalogue entry matches is the
 * value read as `providerID/modelID` (split at the first `/`); an unknown id
 * then yields `undefined` so the caller falls back to the chain. A variant is
 * kept only while the catalogue still offers it, mirroring the live adapter.
 */
export function clientModelRef(
  model: string | undefined,
  variant?: string,
  catalogue?: ReadonlyArray<{
    id: string
    providerID: string
    variants: readonly string[]
    contextLimit?: number
  }>,
): ModelRef | undefined {
  if (model === undefined) return undefined
  const found = catalogue?.find((entry) => entry.id === model)
  if (found !== undefined) {
    const offered = offeredVariant(variant, found.variants)
    const parsed = modelRefSchema.safeParse({
      providerID: found.providerID,
      modelID: found.id,
      ...(offered === undefined ? {} : { variant: offered }),
      ...(found.contextLimit !== undefined && found.contextLimit > 0
        ? { contextLimit: found.contextLimit }
        : {}),
    })
    return parsed.success ? parsed.data : undefined
  }
  if (catalogue !== undefined) return undefined

  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) return undefined
  const parsed = modelRefSchema.safeParse({
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
    ...(variant === undefined ? {} : { variant }),
  })
  return parsed.success ? parsed.data : undefined
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
