import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { dirname, isAbsolute, join, relative } from "node:path"
import type { ErrorCode } from "./errors"

/**
 * The one filesystem read the document tools perform. A template is named by a
 * path relative to `WORKSPACE_DIR/chats`, never by an arbitrary absolute path.
 * Every component is checked for symlinks and containment, the file is opened
 * with O_NOFOLLOW, and its size is capped before the bytes are read.
 */

export const MAX_TEMPLATE_BYTES = 8_388_608

const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.,()+\-]{0,199}\.(docx|dotx)$/i

export type TemplateRead =
  | { ok: true; sessionID: string; name: string; bytes: Uint8Array }
  | { ok: false; code: ErrorCode }

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

export async function readTemplate(
  workspaceDir: string,
  templatePath: string,
): Promise<TemplateRead> {
  if (
    isAbsolute(templatePath) ||
    templatePath.includes("\\") ||
    templatePath.startsWith("/") ||
    templatePath.includes("..")
  ) {
    return { ok: false, code: "invalid_path" }
  }
  const parts = templatePath.split("/")
  if (parts.length !== 3 || parts[1] !== "files") return { ok: false, code: "invalid_path" }
  const [sessionID, , name] = parts as [string, string, string]
  if (!SESSION.test(sessionID) || !FILE_NAME.test(name)) {
    return { ok: false, code: "invalid_path" }
  }

  try {
    const rootReal = await realpath(join(workspaceDir, "chats"))
    const chatReal = await realDirectory(join(rootReal, sessionID))
    if (!chatReal || dirname(chatReal) !== rootReal) return { ok: false, code: "invalid_path" }
    const filesReal = await realDirectory(join(chatReal, "files"))
    if (!filesReal || dirname(filesReal) !== chatReal) return { ok: false, code: "invalid_path" }

    const path = join(filesReal, name)
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      return { ok: false, code: "invalid_path" }
    }
    if (stat.size === 0 || stat.size > MAX_TEMPLATE_BYTES) {
      return { ok: false, code: "too_large" }
    }
    const real = await realpath(path)
    if (dirname(real) !== filesReal || !isInside(filesReal, real)) {
      return { ok: false, code: "invalid_path" }
    }

    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const bytes = await handle.readFile()
      if (bytes.byteLength > MAX_TEMPLATE_BYTES) return { ok: false, code: "too_large" }
      return { ok: true, sessionID, name, bytes: new Uint8Array(bytes) }
    } finally {
      await handle.close()
    }
  } catch {
    return { ok: false, code: "invalid_path" }
  }
}
