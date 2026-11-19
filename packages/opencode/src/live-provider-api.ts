import type { OpenCodeClient } from "@opencode/client"
import type { ModelInfo } from "@openchat/contracts"
import type { ProviderAttemptInput, ProviderKeyInput, ProviderOAuthInput } from "./index"
import { mapHostModel } from "./live-model"
import type { HostModelInfo } from "./live-model"
import {
  liveCancelOAuth,
  liveCompleteOAuth,
  liveConnectKey,
  liveOAuthStatus,
  liveProviders,
  liveStartOAuth,
} from "./live-providers"

/**
 * Provider onboarding methods of the live backend. Kept apart from the session
 * and event surface so `live.ts` stays within the file-length budget; they
 * share only the host client with the rest of the adapter.
 */
export class LiveProviderApi {
  constructor(protected readonly client: OpenCodeClient) {}

  /** Provider display names; a failed probe degrades to the raw provider ids. */
  protected async providerNames(): Promise<Map<string, string>> {
    try {
      const response = await this.client.provider.list()
      return new Map(response.data.map((provider) => [provider.id, provider.name]))
    } catch {
      return new Map()
    }
  }

  async listProviders() {
    return liveProviders(this.client)
  }

  async connectProviderKey(input: ProviderKeyInput): Promise<void> {
    await liveConnectKey(this.client, input)
  }

  async startProviderOAuth(input: ProviderOAuthInput) {
    return liveStartOAuth(this.client, input)
  }

  async providerOAuthStatus(input: { providerID: string; attemptID: string }) {
    return liveOAuthStatus(this.client, input.providerID, input.attemptID)
  }

  async completeProviderOAuth(input: ProviderAttemptInput): Promise<void> {
    await liveCompleteOAuth(this.client, input)
  }

  async cancelProviderOAuth(input: { providerID: string; attemptID: string }): Promise<void> {
    await liveCancelOAuth(this.client, input.providerID, input.attemptID)
  }

  async hostDefaultModel(): Promise<ModelInfo | null> {
    const response = await this.client.model.default()
    const model = response.data
    if (!model) return null
    const names = await this.providerNames()
    const info = mapHostModel(
      model as HostModelInfo,
      names.get(model.providerID) ?? model.providerID,
    )
    info.default = true
    return info
  }
}
