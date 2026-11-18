import type { OpenCodeClient } from "@opencode/client"

type ModelRef = Parameters<OpenCodeClient["session"]["switchModel"]>[0]["model"]
type AgentID = Parameters<OpenCodeClient["session"]["switchAgent"]>[0]["agent"]

/**
 * Applies the browser's persisted choice before a prompt. The pinned client
 * has no `model`/`agent` on `session.prompt`; it exposes the session switches
 * instead, so the two optional `PromptInput` fields become one switch each.
 * Unknown model ids are ignored rather than guessed: the host keeps its default
 * and the conversation still works.
 */
export async function applyCompletion(
  client: OpenCodeClient,
  sessionID: string,
  input: { model?: string; agent?: string },
  providers: () => Promise<Map<string, string>>,
): Promise<void> {
  if (input.model) {
    const providerID = (await providers()).get(input.model)
    if (providerID) {
      await client.session.switchModel({
        sessionID,
        model: { id: input.model, providerID } as ModelRef,
      })
    }
  }
  if (input.agent) {
    await client.session.switchAgent({ sessionID, agent: input.agent as AgentID })
  }
}
