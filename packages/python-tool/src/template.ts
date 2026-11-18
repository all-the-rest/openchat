import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { dirname, isAbsolute, join, relative } from "node:path"
import { MAX_TEMPLATE_BYTES } from "./limits"

/**
 * The only filesystem access the document tools perform. A template is named
 * by a path relative to `WORKSPACE_DIR/chats`, never by an arbitrary absolute
 * path. Every component is checked for symlinks and containment; the file is
 * opened with O_NOFOLLOW and capped before its bytes are read. The same
 * resolver is used when the filled files are written back into that folder.
 */

const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.,()+\-]{0,199}\.(docx|dotx)$/i

export type TemplateRead =
  | { ok: true; sessionID: string; name: string; bytes: Uint8Array }
  | { ok: false; error: string }

interface TemplateParts {
  sessionID: string
  name: string
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

async function realDirectory(path: string): Promise<string | null> {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) return null
  const real = await realpath(path)
  return isInside(dirname(real), real) ? real : null
}

/** The two path segments the caller is allowed to name. */
export function templateParts(templatePath: string): TemplateParts | null {
  if (
    isAbsolute(templatePath) ||
    templatePath.includes("\\") ||
    templatePath.startsWith("/") ||
    templatePath.includes("..")
  ) {
    return null
  }
  const parts = templatePath.split("/")
  if (parts.length !== 3 || parts[1] !== "files") return null
  const [sessionID, , name] = parts as [string, string, string]
  if (!SESSION.test(sessionID) || !FILE_NAME.test(name)) return null
  return { sessionID, name }
}

/** Resolved `chats/<session>/files` or null when a component is a symlink. */
export async function chatFilesDirectory(
  workspaceDir: string,
  sessionID: string,
): Promise<string | null> {
  if (!SESSION.test(sessionID)) return null
  try {
    const rootReal = await realpath(join(workspaceDir, "chats"))
    const chatReal = await realDirectory(join(rootReal, sessionID))
    if (!chatReal || dirname(chatReal) !== rootReal) return null
    const filesReal = await realDirectory(join(chatReal, "files"))
    if (!filesReal || dirname(filesReal) !== chatReal) return null
    return filesReal
  } catch {
    return null
  }
}

export async function readTemplate(
  workspaceDir: string,
  templatePath: string,
): Promise<TemplateRead> {
  const parts = templateParts(templatePath)
  if (!parts) return { ok: false, error: "templatePath: use a path inside WORKSPACE_DIR/chats/<session>/files" }

  try {
    const filesReal = await chatFilesDirectory(workspaceDir, parts.sessionID)
    if (!filesReal) return { ok: false, error: "templatePath: the chat directory is not a safe directory" }

    const path = join(filesReal, parts.name)
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      return { ok: false, error: "templatePath: not a regular file" }
    }
    if (stat.size === 0 || stat.size > MAX_TEMPLATE_BYTES) {
      return { ok: false, error: "templatePath: larger than the 8 MiB template cap" }
    }
    const real = await realpath(path)
    if (dirname(real) !== filesReal || !isInside(filesReal, real)) {
      return { ok: false, error: "templatePath: escapes the chat files directory" }
    }

    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const bytes = await handle.readFile()
      if (bytes.byteLength > MAX_TEMPLATE_BYTES) {
        return { ok: false, error: "templatePath: larger than the 8 MiB template cap" }
      }
      return { ok: true, sessionID: parts.sessionID, name: parts.name, bytes: new Uint8Array(bytes) }
    } finally {
      await handle.close()
    }
  } catch {
    return { ok: false, error: "templatePath: could not be read safely" }
  }
}
