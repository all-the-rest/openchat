/**
 * The wire format that tells the agent where uploaded bytes live.
 *
 * `PromptInput` has only `text`, so the reference is a documented block
 * appended to the prompt. The bytes are never inlined: the agent reads the
 * file from the shared `/workspace` volume, where the BFF's `WORKSPACE_DIR`
 * is mounted at the same path. The block is a protocol constant, not UI copy,
 * so it stays identical in every locale.
 */
export const CHAT_FILE_CONTAINER_ROOT = "/workspace/chats"

export const ATTACHMENT_HEADER = "Attached files:"

/** One stored name -> its absolute path inside the agent container. */
export function attachmentFilePath(sessionID: string, storedName: string): string {
  return `${CHAT_FILE_CONTAINER_ROOT}/${sessionID}/files/${storedName}`
}

/**
 * Renders the reference block for the stored names the server returned.
 * Returns an empty string when nothing was attached, so callers can append it
 * to a prompt without special-casing the no-file path.
 */
export function formatAttachmentReferences(
  sessionID: string,
  storedNames: readonly string[],
): string {
  if (storedNames.length === 0) return ""
  const lines = storedNames.map(
    (name) => `- ${name} (${attachmentFilePath(sessionID, name)})`,
  )
  return `${ATTACHMENT_HEADER}\n${lines.join("\n")}`
}

/** Appends the block after a blank line, leaving the typed prompt untouched. */
export function withAttachmentReferences(
  text: string,
  sessionID: string,
  storedNames: readonly string[],
): string {
  const block = formatAttachmentReferences(sessionID, storedNames)
  return block.length === 0 ? text : `${text}\n\n${block}`
}
