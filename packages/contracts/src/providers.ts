import { z } from "zod"

/**
 * Provider setup surface (issue #50). The host owns the catalogue: the BFF
 * reduces `integration.list()` to what the first-run card needs and never
 * forwards upstream text. A secret arrives in `key` and never leaves the BFF
 * towards the browser again.
 */
export type ProviderMethodType = "key" | "oauth" | "command" | "external" | "env"

export interface ProviderFormOption {
  value: string
  label: string
}

/**
 * One declared form field. `secret` marks the single field whose value travels
 * as the top-level `key` of a key connection, so it is never repeated inside
 * `answer`. Percentages and numeric sentinels from the host are dropped.
 */
export interface ProviderFormField {
  key: string
  title?: string
  description?: string
  required: boolean
  type: "string" | "number" | "integer" | "boolean" | "multiselect"
  secret: boolean
  format?: "email" | "uri" | "date" | "date-time"
  minLength?: number
  maxLength?: number
  pattern?: string
  placeholder?: string
  options?: ProviderFormOption[]
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
  defaultValue?: string | number | boolean | string[]
}

export interface ProviderMethod {
  id: string
  type: ProviderMethodType
  label: string
  form: ProviderFormField[]
}

export interface ProviderConnectionInfo {
  id: string
  label: string
  method: "key" | "oauth" | "external" | "env"
  active: boolean
}

export interface ProviderInfo {
  id: string
  name: string
  connected: boolean
  methods: ProviderMethod[]
  connections: ProviderConnectionInfo[]
}

/** The catalogue is a bare array, like `/api/models`. */
export type ProvidersResponse = ProviderInfo[]

export type ProviderFormAnswer = Record<string, string | number | boolean | string[]>

export interface ProviderKeyConnectRequest {
  methodID?: string
  /** The secret. The BFF forwards it to the host once and never returns it. */
  key: string
  answer?: ProviderFormAnswer
  label?: string
}

export interface ProviderOAuthConnectRequest {
  methodID: string
  answer?: ProviderFormAnswer
  label?: string
}

export interface ProviderOAuthCompleteRequest {
  code?: string
}

export interface ProviderConnectResponse {
  ok: true
}

/** One started OAuth attempt; `url` or `code` is what the browser needs. */
export interface ProviderOAuthAttempt {
  id: string
  url: string | null
  instructions: string | null
  code: string | null
  /** True when the host expects a pasted code in the complete call. */
  needsCode: boolean
  expires: number
}

export interface ProviderOAuthStartResponse {
  attempt: ProviderOAuthAttempt
}

export type ProviderAttemptState = "pending" | "complete" | "failed" | "expired"

export interface ProviderOAuthStatusResponse {
  status: ProviderAttemptState
}

/** The model catalogue after a connection attempt. */
export interface ProviderStatusResponse {
  models: Array<{ id: string; name: string; providerID: string }>
}

/** The host-wide default; read-only, because the API only exposes a read. */
export interface HostDefaultModelResponse {
  model: { id: string; name: string; providerID: string } | null
}

const formAnswerSchema = z.record(
  z.string().min(1).max(200),
  z.union([
    z.string().max(4_000),
    z.number(),
    z.boolean(),
    z.array(z.string().max(2_000)).max(50),
  ]),
)

const labelSchema = z.string().min(1).max(120)
const methodIDSchema = z.string().min(1).max(200)

export const providerKeyConnectRequestSchema = z.object({
  methodID: methodIDSchema.optional(),
  // A provider key can be long; the body cap still bounds the request.
  key: z.string().min(1).max(20_000),
  answer: formAnswerSchema.optional(),
  label: labelSchema.optional(),
})

export const providerOAuthConnectRequestSchema = z.object({
  methodID: methodIDSchema,
  answer: formAnswerSchema.optional(),
  label: labelSchema.optional(),
})

export const providerOAuthCompleteRequestSchema = z.object({
  code: z.string().min(1).max(4_096).optional(),
})
