import type {
  MemoryAuditResponse,
  MemoryCreateRequest,
  MemoryDeleteRequest,
  MemoryExport,
  MemoryFactResponse,
  MemoryIndexResponse,
  MemoryListResponse,
  MemoryUpdateRequest,
} from "@openchat/contracts"

/** The JSON helper of `client.ts`; injected so this module stays testable. */
export type JsonRequest = <T>(path: string, init?: RequestInit) => Promise<T>

/** Owner memory routes, split out of the growing API client. */
export function memoryApi(request: JsonRequest) {
  return {
    /** The owner's durable memory, without soft-deleted rows. */
    memory(): Promise<MemoryListResponse> {
      return request<MemoryListResponse>("/api/memory")
    },

    /** The exact index injected into sessions, with its token estimate. */
    memoryIndex(): Promise<MemoryIndexResponse> {
      return request<MemoryIndexResponse>("/api/memory/index")
    },

    /** The append-only audit tail, newest last. */
    memoryAudit(limit = 40): Promise<MemoryAuditResponse> {
      return request<MemoryAuditResponse>(`/api/memory/audit?limit=${String(limit)}`)
    },

    /** The explicit export; the button downloads this document. */
    memoryExport(): Promise<MemoryExport> {
      return request<MemoryExport>("/api/memory/export")
    },

    createMemory(input: MemoryCreateRequest): Promise<MemoryFactResponse> {
      return request<MemoryFactResponse>("/api/memory", {
        method: "POST",
        body: JSON.stringify(input),
      })
    },

    updateMemory(id: string, input: MemoryUpdateRequest): Promise<MemoryFactResponse> {
      return request<MemoryFactResponse>(`/api/memory/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      })
    },

    deleteMemory(id: string, reason: string): Promise<void> {
      const body: MemoryDeleteRequest = { reason }
      return request<void>(`/api/memory/${encodeURIComponent(id)}`, {
        method: "DELETE",
        body: JSON.stringify(body),
      })
    },
  }
}
