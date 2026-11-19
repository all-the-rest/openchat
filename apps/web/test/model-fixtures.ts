import type { AgentInfo, ModelInfo } from "@openchat/contracts"

/** Three providers, one two-variant model, one deprecated model. */
export const MODELS: ModelInfo[] = [
  {
    id: "gpt-x", name: "GPT X", providerID: "openai", providerName: "OpenAI",
    variants: ["fast", "slow"], contextLimit: 128_000,
    capabilities: { tools: true, reasoning: true, image: false }, status: "active",
  },
  {
    id: "fake/echo", name: "Fake Echo", providerID: "fake", providerName: "Fake Provider",
    variants: [], contextLimit: 64_000,
    capabilities: { tools: false, reasoning: false, image: true }, status: "deprecated",
  },
  {
    id: "local/phi", name: "Phi Local", providerID: "local", providerName: "Local Models",
    variants: [], contextLimit: 8_000,
    capabilities: { tools: true, reasoning: false, image: false }, status: "active",
  },
]

export const AGENTS: AgentInfo[] = [{ id: "build", name: "Build" }]

export const CATALOGUE = { models: MODELS, agents: AGENTS }
