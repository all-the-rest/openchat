import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { extname, join } from "node:path"
import { MAX_CHAT_OUTPUT_BYTES } from "./limits"
import { chatFilesDirectory, templateParts } from "./template"

/**
 * Writes generated files next to the uploaded template in the same chat's
 * `files/` directory. Names are single segments, collisions get `-1`, `-2`, …
 * and an existing symlink is never followed or replaced.
 */

export interface ChatOutput {
  name: string
  bytes: Uint8Array
}

export type ChatWriteResult =
  | { ok: true; names: string[] }
  | { ok: false; error: string }

export type ChatFileResult = { ok: true; name: string } | { ok: false; error: string }

const SAFE_OUTPUT = /^[A-Za-z0-9][A-Za-z0-9 _.,()+\-]{0,199}\.(docx|pdf)$/i
const MAX_SUFFIX = 99

function baseName(templatePath: string, requested: string | undefined): string {
  const parts = templateParts(templatePath)
  const stem = parts ? parts.name.replace(extname(parts.name), "") : "document"
  const clean = (requested ?? stem).replace(/[^A-Za-z0-9 _.-]/g, "_").replace(/^\.+/, "")
  return clean.length > 0 && clean.length <= 120 ? clean : stem
}

function suffixed(name: string, suffix: number): string {
  const extension = extname(name)
  return `${name.slice(0, -extension.length)}-${suffix}${extension}`
}

/**
 * The one write path: `O_EXCL | O_NOFOLLOW`, 0600, and `-1`, `-2`, … until a
 * free name is found. `null` means every candidate was taken or stopped being
 * a safe name; an I/O error is thrown and mapped by the caller.
 */
async function writeNew(
  filesReal: string,
  wanted: string,
  bytes: Uint8Array,
): Promise<string | null> {
  for (let suffix = 0; suffix <= MAX_SUFFIX; suffix += 1) {
    const candidate = suffix === 0 ? wanted : suffixed(wanted, suffix)
    if (!SAFE_OUTPUT.test(candidate)) return null
    try {
      const handle = await open(
        join(filesReal, candidate),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        await handle.writeFile(bytes)
      } finally {
        await handle.close()
      }
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error
    }
  }
  return null
}

export async function writeChatOutputs(
  workspaceDir: string,
  templatePath: string,
  requestedName: string | undefined,
  outputs: ChatOutput[],
): Promise<ChatWriteResult> {
  const parts = templateParts(templatePath)
  if (!parts) return { ok: false, error: "templatePath: use a path inside WORKSPACE_DIR/chats" }
  const filesReal = await chatFilesDirectory(workspaceDir, parts.sessionID)
  if (!filesReal) return { ok: false, error: "templatePath: the chat directory is not a safe directory" }

  const stem = baseName(templatePath, requestedName)
  const names: string[] = []
  try {
    for (const output of outputs) {
      if (output.bytes.byteLength === 0 || output.bytes.byteLength > MAX_CHAT_OUTPUT_BYTES) {
        return { ok: false, error: "size: the generated file exceeds the chat file cap" }
      }
      const wanted = `${stem}${extname(output.name).toLowerCase()}`
      if (!SAFE_OUTPUT.test(wanted)) {
        return { ok: false, error: "outputName: use letters, digits, space, dot, dash or underscore" }
      }
      const stored = await writeNew(filesReal, wanted, output.bytes)
      if (!stored) return { ok: false, error: "outputName: no free file name in this chat" }
      names.push(stored)
    }
    return { ok: true, names }
  } catch {
    return { ok: false, error: "io: the generated file could not be stored in this chat" }
  }
}

/**
 * Writes one new document (no template needed) into the chat folder named by
 * `chatPath`. The directory comes from the same guarded resolver as the
 * template tools; only the last path segment is used as the file name, and an
 * existing name is never replaced.
 */
export async function writeChatFile(
  workspaceDir: string,
  chatPath: string,
  bytes: Uint8Array,
): Promise<ChatFileResult> {
  const parts = templateParts(chatPath)
  if (!parts) return { ok: false, error: "chatPath: use a path inside WORKSPACE_DIR/chats" }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CHAT_OUTPUT_BYTES) {
    return { ok: false, error: "size: the generated file exceeds the chat file cap" }
  }
  const filesReal = await chatFilesDirectory(workspaceDir, parts.sessionID)
  if (!filesReal) return { ok: false, error: "chatPath: the chat directory is not a safe directory" }
  if (!SAFE_OUTPUT.test(parts.name)) {
    return { ok: false, error: "chatPath: use letters, digits, space, dot, dash or underscore" }
  }
  try {
    const stored = await writeNew(filesReal, parts.name, bytes)
    if (!stored) return { ok: false, error: "chatPath: no free file name in this chat" }
    return { ok: true, name: stored }
  } catch {
    return { ok: false, error: "io: the generated file could not be stored in this chat" }
  }
}
