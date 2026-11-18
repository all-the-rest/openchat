/**
 * Deterministic fixtures for the offline upload E2E spec. The BFF sniffs these
 * exact bytes, so the headers carry valid PNG/PDF magic and no fixture is
 * fetched from a network.
 */
export const E2E_PDF_NAME = "report.pdf"
export const E2E_PNG_NAME = "pasted.png"

export const E2E_PDF_BYTES = Buffer.concat([
  Buffer.from("%PDF-1.7\n", "latin1"),
  Buffer.from("1 0 obj\n<< /Type /Catalog >>\nendobj\n", "latin1"),
  Buffer.from("%%EOF\n", "latin1"),
])

export const E2E_PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("E2E fixture image bytes", "latin1"),
])

export const E2E_HTML_BYTES = Buffer.from(
  "<!DOCTYPE html><html><body>not a text file</body></html>",
  "utf8",
)

/** The line the agent reads from the prompt, with no filesystem path of the client. */
export function expectedReference(sessionID: string, name = E2E_PDF_NAME): string {
  return `- ${name} (/workspace/chats/${sessionID}/files/${name})`
}
