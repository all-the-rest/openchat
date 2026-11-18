import type { ModelInfo } from "@openchat/contracts"
import type { RecordedPrompt } from "./fake-state"

export type { RecordedPrompt }

/**
 * Deterministic model catalogue. Two providers exercise picker grouping, the
 * two-variant rows exercise variant forwarding, and one model is deprecated so
 * its status badge is visible in fake mode.
 */
export const FAKE_MODELS: readonly ModelInfo[] = [
  {
    id: "fake/echo",
    name: "Fake Echo",
    providerID: "fake",
    providerName: "Fake Provider",
    variants: ["fast", "thorough"],
    contextLimit: 128_000,
    capabilities: { tools: true, reasoning: false, image: false },
    status: "active",
  },
  {
    id: "fake/reasoner",
    name: "Fake Reasoner",
    providerID: "fake",
    providerName: "Fake Provider",
    variants: [],
    contextLimit: 64_000,
    capabilities: { tools: true, reasoning: true, image: true },
    status: "active",
  },
  {
    id: "fake/legacy",
    name: "Fake Legacy",
    providerID: "fake",
    providerName: "Fake Provider",
    variants: [],
    contextLimit: 8_000,
    capabilities: { tools: false, reasoning: false, image: false },
    status: "deprecated",
  },
  {
    id: "echo/prime",
    name: "Echo Prime",
    providerID: "echo",
    providerName: "Echo Labs",
    variants: ["low", "high"],
    contextLimit: 200_000,
    capabilities: { tools: true, reasoning: true, image: false },
    status: "active",
  },
]

/** The subset of a prompt the fake records; mirrors `PromptInput`. */
export interface RecordedInput {
  text: string
  model?: string
  variant?: string
  agent?: string
}

/** Records only the fields the browser actually sent; never invents a variant. */
export function recordPrompt(
  recorded: Map<string, RecordedPrompt>,
  sessionID: string,
  input: RecordedInput,
): void {
  const entry: RecordedPrompt = { text: input.text }
  if (input.model !== undefined) entry.model = input.model
  if (input.variant !== undefined) entry.variant = input.variant
  if (input.agent !== undefined) entry.agent = input.agent
  recorded.set(sessionID, entry)
}
