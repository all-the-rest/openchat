import type { ModelRef as ClientModelRef, OpenCodeClient } from "@opencode/client"
import type { ModelInfo, ModelRef, ModelStatus } from "@openchat/contracts"

type AgentID = Parameters<OpenCodeClient["session"]["switchAgent"]>[0]["agent"]

/** The host fields we read from a chat model; older hosts omit the metadata. */
export interface HostModelInfo {
  modelID: string
  name: string
  providerID: string
  variants?: ReadonlyArray<{ id: string }>
  limit?: { context?: number }
  capabilities?: { tools?: boolean; input?: readonly string[]; output?: readonly string[] }
  status?: ModelStatus
}

/** Maps one host model to the contract, tolerating missing optional metadata. */
export function mapHostModel(model: HostModelInfo, providerName: string): ModelInfo {
  return {
    id: model.modelID,
    name: model.name,
    providerID: model.providerID,
    providerName,
    variants: model.variants?.map((variant) => variant.id) ?? [],
    contextLimit: model.limit?.context ?? 0,
    capabilities: {
      tools: model.capabilities?.tools ?? false,
      reasoning:
        model.capabilities?.output?.includes("reasoning") ?? false,
      image: model.capabilities?.input?.includes("image") ?? false,
    },
    status: model.status ?? "active",
  }
}

/** Provider ids and the variants each host model still offers. */
export type ModelHostInfo = Map<string, { providerID: string; variants: readonly string[] }>

/**
 * Applies the browser's persisted choice before a prompt. The pinned client
 * has no `model`/`agent` on `session.prompt`; it exposes the session switches
 * instead, so the optional `PromptInput` fields become one switch each.
 *
 * Two guards keep a stale browser state from reaching the host: an unknown
 * model is ignored (the host keeps its default), and a variant the model no
 * longer offers is dropped from the model ref.
 */
export async function applyCompletion(
  client: OpenCodeClient,
  sessionID: string,
  input: { model?: string; variant?: string; agent?: string; modelRef?: ModelRef },
  providers: () => Promise<ModelHostInfo>,
): Promise<void> {
  if (input.modelRef) {
    // Full switch target from the fallback engine: no catalogue lookup needed.
    const ref: ClientModelRef = {
      id: input.modelRef.modelID,
      providerID: input.modelRef.providerID,
      ...(input.modelRef.variant ? { variant: input.modelRef.variant } : {}),
    }
    await client.session.switchModel({ sessionID, model: ref })
  } else if (input.model) {
    const info = (await providers()).get(input.model)
    if (info) {
      const variant =
        input.variant && info.variants.includes(input.variant) ? input.variant : undefined
      const ref: ClientModelRef = {
        id: input.model,
        providerID: info.providerID,
        ...(variant ? { variant } : {}),
      }
      await client.session.switchModel({ sessionID, model: ref })
    }
  }
  if (input.agent) {
    await client.session.switchAgent({ sessionID, agent: input.agent as AgentID })
  }
}
