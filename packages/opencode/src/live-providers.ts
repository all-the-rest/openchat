import type {
  ConnectionInfo,
  FormField,
  IntegrationInfo,
  IntegrationMethod,
  OpenCodeClient,
} from "@opencode/client"
import type {
  ProviderConnectionInfo,
  ProviderFormField,
  ProviderFormOption,
  ProviderInfo,
  ProviderMethod,
  ProviderOAuthAttempt,
} from "@openchat/contracts"
import type {
  ProviderAttemptInput,
  ProviderKeyInput,
  ProviderOAuthInput,
  ProviderOAuthStatus,
} from "./index"

type HostFormField = FormField

/** Numeric sentinels in the host schema are not JSON numbers; drop them. */
function finiteNumber(value: number | "Infinity" | "-Infinity" | "NaN" | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function optionsOf(field: HostFormField): ProviderFormOption[] | undefined {
  if (!("options" in field) || !Array.isArray(field.options)) return undefined
  return field.options.map((option) => ({ value: option.value, label: option.label }))
}

/**
 * Reduces a host form field to the JSON shape the browser renders. The first
 * string field named like a credential becomes `secret`; that value travels as
 * the top-level `key` and is never repeated inside `answer`.
 */
function mapField(field: HostFormField, secret: boolean): ProviderFormField {
  if (field.type === "external") {
    // External fields are links the host owns; nothing to collect here.
    return {
      key: field.key,
      title: field.title,
      description: field.description,
      required: false,
      type: "string",
      secret: false,
      placeholder: field.url,
    }
  }
  const base = {
    key: field.key,
    title: field.title,
    description: field.description,
    required: field.required === true,
    secret,
  }
  if (field.type === "string") {
    return {
      ...base,
      type: "string",
      format: field.format,
      minLength: field.minLength,
      maxLength: field.maxLength,
      pattern: field.pattern,
      placeholder: field.placeholder,
      options: optionsOf(field),
      defaultValue: field.default,
    }
  }
  if (field.type === "number" || field.type === "integer") {
    return {
      ...base,
      type: field.type,
      minimum: finiteNumber(field.minimum),
      maximum: finiteNumber(field.maximum),
      defaultValue: finiteNumber(field.default),
    }
  }
  if (field.type === "boolean") {
    return { ...base, type: "boolean", defaultValue: field.default }
  }
  return {
    ...base,
    type: "multiselect",
    options: optionsOf(field) ?? [],
    minItems: field.minItems,
    maxItems: field.maxItems,
    defaultValue: field.default,
  }
}

const SECRET_KEYS = new Set(["key", "apiKey", "api_key", "token", "secret", "password"])

function formOf(method: IntegrationMethod): ProviderFormField[] {
  const form = "form" in method ? method.form : undefined
  if (!form) return []
  let secretSeen = false
  return form.map((field) => {
    const wantsSecret =
      !secretSeen && field.type === "string" && SECRET_KEYS.has(field.key)
    if (wantsSecret) secretSeen = true
    return mapField(field, wantsSecret)
  })
}

function methodOf(method: IntegrationMethod): ProviderMethod {
  if (method.type === "key") {
    return { id: "key", type: "key", label: method.label ?? "API key", form: formOf(method) }
  }
  if (method.type === "oauth") {
    return { id: method.id, type: "oauth", label: method.label, form: formOf(method) }
  }
  if (method.type === "command") {
    return { id: method.id, type: "command", label: method.label, form: [] }
  }
  if (method.type === "external") {
    return { id: method.id, type: "external", label: method.label, form: formOf(method) }
  }
  return { id: "env", type: "env", label: "Environment", form: [] }
}

function connectionOf(connection: ConnectionInfo): ProviderConnectionInfo {
  if (connection.type === "credential") {
    return {
      id: connection.id,
      label: connection.label,
      method: connection.method,
      active: true,
    }
  }
  return { id: `env:${connection.name}`, label: connection.name, method: "env", active: true }
}

export function mapProvider(info: IntegrationInfo): ProviderInfo {
  const connections = info.connections.map(connectionOf)
  return {
    id: info.id,
    name: info.name,
    connected: connections.length > 0,
    methods: info.methods.map(methodOf),
    connections,
  }
}

export async function liveProviders(client: OpenCodeClient): Promise<ProviderInfo[]> {
  const response = await client.integration.list()
  return response.data.map(mapProvider)
}

export async function liveConnectKey(
  client: OpenCodeClient,
  input: ProviderKeyInput,
): Promise<void> {
  await client.integration.connect.key({
    integrationID: input.providerID,
    key: input.key,
    answer: input.answer,
    label: input.label,
  })
}

export async function liveStartOAuth(
  client: import("@opencode/client").OpenCodeClient,
  input: ProviderOAuthInput,
): Promise<ProviderOAuthAttempt> {
  const response = await client.integration.oauth.connect({
    integrationID: input.providerID,
    methodID: input.methodID,
    answer: input.answer,
    label: input.label,
  })
  const attempt = response.data
  return {
    id: attempt.attemptID,
    url: attempt.url.length > 0 ? attempt.url : null,
    instructions: attempt.instructions.length > 0 ? attempt.instructions : null,
    // The URL is the only browser-facing handle the host returns; a paste code
    // arrives through the attempt's instructions when the host supports it.
    code: null,
    needsCode: attempt.mode === "code" || attempt.paste === true,
    expires: attempt.time.expires,
  }
}

/** Maps the host's attempt states onto the stable browser vocabulary. */
export function mapOAuthStatus(status: string): ProviderOAuthStatus {
  if (status === "complete" || status === "failed" || status === "expired") return status
  return "pending"
}

export async function liveOAuthStatus(
  client: OpenCodeClient,
  providerID: string,
  attemptID: string,
): Promise<ProviderOAuthStatus> {
  const response = await client.integration.oauth.status({
    integrationID: providerID,
    attemptID,
  })
  return mapOAuthStatus(response.data.status)
}

export async function liveCompleteOAuth(
  client: OpenCodeClient,
  input: ProviderAttemptInput,
): Promise<void> {
  await client.integration.oauth.complete({
    integrationID: input.providerID,
    attemptID: input.attemptID,
    code: input.code,
  })
}

export async function liveCancelOAuth(
  client: OpenCodeClient,
  providerID: string,
  attemptID: string,
): Promise<void> {
  await client.integration.oauth.cancel({ integrationID: providerID, attemptID })
}
