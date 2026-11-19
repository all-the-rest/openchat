import type {
  HostDefaultModelResponse,
  ProviderConnectResponse,
  ProviderInfo,
  ProviderKeyConnectRequest,
  ProviderOAuthConnectRequest,
  ProviderOAuthStartResponse,
  ProviderOAuthStatusResponse,
  ProviderStatusResponse,
} from "@openchat/contracts"

/** The shared JSON transport from `client.ts`; kept injectable so this file
 * stays independent of the rest of the API surface. */
type Request = <T>(path: string, init?: RequestInit) => Promise<T>

const providerPath = (id: string) => `/api/providers/${encodeURIComponent(id)}`

/**
 * Provider onboarding endpoints. The catalogue is a bare array, but accepting
 * a wrapped key too keeps the client robust while the server surface settles.
 */
export function providerEndpoints(request: Request) {
  return {
    hostDefaultModel(): Promise<HostDefaultModelResponse> {
      return request<HostDefaultModelResponse>("/api/models/default")
    },

    async providers(): Promise<ProviderInfo[]> {
      const body = await request<unknown>("/api/providers")
      if (Array.isArray(body)) return body as ProviderInfo[]
      if (body !== null && typeof body === "object") {
        const candidate = (body as Record<string, unknown>).providers
        if (Array.isArray(candidate)) return candidate as ProviderInfo[]
      }
      return []
    },

    connectProviderKey(
      id: string,
      input: ProviderKeyConnectRequest,
    ): Promise<ProviderConnectResponse> {
      return request<ProviderConnectResponse>(`${providerPath(id)}/connect/key`, {
        method: "POST",
        body: JSON.stringify(input),
      })
    },

    startProviderOAuth(
      id: string,
      input: ProviderOAuthConnectRequest,
    ): Promise<ProviderOAuthStartResponse> {
      return request<ProviderOAuthStartResponse>(`${providerPath(id)}/connect/oauth`, {
        method: "POST",
        body: JSON.stringify(input),
      })
    },

    providerOAuthStatus(id: string, attemptID: string): Promise<ProviderOAuthStatusResponse> {
      return request<ProviderOAuthStatusResponse>(
        `${providerPath(id)}/connect/oauth/${encodeURIComponent(attemptID)}`,
      )
    },

    completeProviderOAuth(id: string, attemptID: string, code?: string): Promise<void> {
      return request<void>(
        `${providerPath(id)}/connect/oauth/${encodeURIComponent(attemptID)}/complete`,
        { method: "POST", body: JSON.stringify(code ? { code } : {}) },
      )
    },

    cancelProviderOAuth(id: string, attemptID: string): Promise<void> {
      return request<void>(
        `${providerPath(id)}/connect/oauth/${encodeURIComponent(attemptID)}`,
        { method: "DELETE", body: JSON.stringify({}) },
      )
    },

    /** The model catalogue re-read after a connection; never cached. */
    providerStatus(): Promise<ProviderStatusResponse> {
      return request<ProviderStatusResponse>("/api/providers/status")
    },
  }
}
