import type { MessageKey } from "../i18n/messages/en"

/** Stable BFF codes map to one translated sentence; unknown codes stay generic. */
export function memoryErrorKey(code: string | undefined): MessageKey {
  switch (code) {
    case "memory_secret_rejected":
      return "memory.error.secret"
    case "memory_instruction_rejected":
      return "memory.error.instruction"
    case "memory_duplicate":
      return "memory.error.duplicate"
    case "memory_invalid":
    case "memory_too_large":
      return "memory.error.invalid"
    case "memory_store_full":
      return "memory.error.storeFull"
    default:
      return "memory.error.generic"
  }
}

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}
