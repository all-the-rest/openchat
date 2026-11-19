import { BackendError } from "./errors"
import type { ProviderKeyInput, ProviderOAuthInput, ProviderOAuthStatus } from "./index"
import type {
  ModelInfo,
  ProviderFormField,
  ProviderInfo,
  ProviderOAuthAttempt,
} from "@openchat/contracts"
import { FAKE_MODELS } from "./fake-completion"

/** Metadata of one recorded key connect; the key itself is never kept. */
export interface FakeConnectRecord {
  providerID: string
  methodID: string
  label: string | null
  keyLength: number
}

export interface FakeProviderRecord {
  connects: FakeConnectRecord[]
  oauthStarts: number
  oauthCancels: number
}

export interface FakeIntegrationsOptions {
  /** Injected clock for deterministic attempt expiry. */
  now?: () => number
  /** False starts without a model, so first-run is reachable in a browser. */
  seedModels?: boolean
  /** How long an OAuth attempt stays pending. Defaults to 1 s. */
  oauthDelayMs?: number
}

interface FakeAttempt {
  id: string
  created: number
  expires: number
  url: string
  instructions: string
  completed: boolean
}

/** The connected provider yields the seeded catalogue's default model. */
const CONNECTED_MODEL = FAKE_MODELS.find((model) => model.default) ?? FAKE_MODELS[0]!
const OAUTH_DELAY_MS = 1_000
const ATTEMPT_TTL_MS = 60_000

function field(partial: ProviderFormField & { key: string }): ProviderFormField {
  return partial
}

/**
 * Deterministic provider inventory. The catalogue has one key method with a
 * validating form, one OAuth-looking method and one host-only command method,
 * so both the in-app flow and the escape hatch have a reachable fixture.
 *
 * A successful key connect records its metadata and makes one model appear.
 * The secret is reduced to its length at the boundary and never stored.
 */
export class FakeIntegrations {
  private readonly now: () => number
  private readonly oauthDelayMs: number
  private readonly records: FakeConnectRecord[] = []
  private readonly connections: ProviderInfo["connections"] = []
  private readonly attempts = new Map<string, FakeAttempt>()
  private readonly seeded: boolean
  private connected = false
  private oauthStarts = 0
  private oauthCancels = 0
  private nextAttempt = 0

  constructor(options: FakeIntegrationsOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.seeded = options.seedModels ?? true
    this.oauthDelayMs = options.oauthDelayMs ?? OAUTH_DELAY_MS
  }

  /**
   * The seeded fake reports the full catalogue; a fresh connection yields its
   * default model. Both are picker-ready `ModelInfo` values, never bare ids.
   */
  models(): ModelInfo[] {
    if (!this.seeded && !this.connected) return []
    return (this.seeded ? FAKE_MODELS : [CONNECTED_MODEL]).map((model) => structuredClone(model))
  }

  defaultModel(): ModelInfo | null {
    return this.models().find((model) => model.default) ?? this.models()[0] ?? null
  }

  providers(): ProviderInfo[] {
    const methods = [
      {
        id: "api-key",
        type: "key" as const,
        label: "API key",
        form: [
          field({
            key: "key",
            title: "API key",
            description: "The key from the provider dashboard.",
            required: true,
            type: "string",
            secret: true,
            minLength: 8,
            maxLength: 200,
            placeholder: "sk-…",
          }),
          field({
            key: "region",
            title: "Region",
            required: true,
            type: "string",
            secret: false,
            options: [
              { value: "eu", label: "Europe" },
              { value: "us", label: "United States" },
            ],
            defaultValue: "eu",
          }),
        ],
      },
      {
        id: "browser",
        type: "oauth" as const,
        label: "Sign in with a browser",
        form: [
          field({
            key: "workspace",
            title: "Workspace",
            description: "Optional workspace slug, lower-case letters and dashes.",
            required: false,
            type: "string",
            secret: false,
            minLength: 3,
            maxLength: 40,
            pattern: "^[a-z0-9-]+$",
          }),
        ],
      },
      {
        id: "cli",
        type: "command" as const,
        label: "Sign in with the command line",
        form: [],
      },
    ]
    return [
      {
        id: "fake-cloud",
        name: "Fake Cloud",
        connected: this.connected,
        methods,
        connections: this.connections.map((entry) => ({ ...entry })),
      },
    ]
  }

  connectKey(input: ProviderKeyInput): void {
    this.requireProvider(input.providerID)
    // The route validates against the form first; the length check is the
    // fake's own guard so a route regression still fails a test.
    if (input.key.length < 8) {
      throw new BackendError("invalid", "The fake provider requires a longer key")
    }
    this.records.push({
      providerID: input.providerID,
      methodID: input.methodID ?? "api-key",
      label: input.label ?? null,
      keyLength: input.key.length,
    })
    this.connections.length = 0
    this.connections.push({
      id: `cred-${this.records.length}`,
      label: input.label ?? "API key",
      method: "key",
      active: true,
    })
    this.connected = true
  }

  startOAuth(input: ProviderOAuthInput): ProviderOAuthAttempt {
    this.requireProvider(input.providerID)
    this.requireMethod(input.providerID, input.methodID, "oauth")
    const created = this.now()
    const id = `attempt-${(this.nextAttempt += 1)}`
    this.attempts.set(id, {
      id,
      created,
      expires: created + ATTEMPT_TTL_MS,
      url: `https://example.invalid/authorize/${id}`,
      instructions: "Open the sign-in page and approve access.",
      completed: false,
    })
    this.oauthStarts += 1
    return {
      id,
      url: `https://example.invalid/authorize/${id}`,
      instructions: "Open the sign-in page and approve access.",
      code: null,
      needsCode: false,
      expires: created + ATTEMPT_TTL_MS,
    }
  }

  oauthStatus(attemptID: string): ProviderOAuthStatus {
    const attempt = this.requireAttempt(attemptID)
    if (this.now() >= attempt.expires) return "expired"
    if (attempt.completed || this.now() >= attempt.created + this.oauthDelayMs) {
      attempt.completed = true
      this.completeConnection()
      return "complete"
    }
    return "pending"
  }

  completeOAuth(attemptID: string): void {
    this.requireAttempt(attemptID).completed = true
    this.completeConnection()
  }

  cancelOAuth(attemptID: string): void {
    this.requireAttempt(attemptID)
    this.attempts.delete(attemptID)
    this.oauthCancels += 1
  }

  recorded(): FakeProviderRecord {
    return {
      connects: this.records.map((entry) => ({ ...entry })),
      oauthStarts: this.oauthStarts,
      oauthCancels: this.oauthCancels,
    }
  }

  private completeConnection(): void {
    if (this.connected) return
    this.connected = true
    this.connections.push({ id: "cred-oauth", label: "OAuth", method: "oauth", active: true })
  }

  private requireAttempt(attemptID: string): FakeAttempt {
    const attempt = this.attempts.get(attemptID)
    if (!attempt) throw new BackendError("not_found", `Unknown provider attempt: ${attemptID}`)
    return attempt
  }

  private requireProvider(providerID: string): ProviderInfo {
    const provider = this.providers().find((entry) => entry.id === providerID)
    if (!provider) throw new BackendError("not_found", `Unknown provider: ${providerID}`)
    return provider
  }

  private requireMethod(providerID: string, methodID: string, type: string): void {
    const provider = this.requireProvider(providerID)
    const method = provider.methods.find((entry) => entry.id === methodID && entry.type === type)
    if (!method) {
      throw new BackendError("not_found", `Unknown provider method: ${methodID}`)
    }
  }
}
