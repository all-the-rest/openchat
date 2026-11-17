export type BackendErrorCode = "not_found" | "conflict" | "invalid"

/** A failure the BFF can map onto a stable HTTP status. */
export class BackendError extends Error {
  readonly code: BackendErrorCode

  constructor(code: BackendErrorCode, message: string) {
    super(message)
    this.name = "BackendError"
    this.code = code
  }
}
