import { readFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * The id shape is checked before any path is built, so `..`, an absolute path
 * or a NUL byte cannot reach the filesystem. Only lowercase hex is accepted:
 * the BFF names directories after the SHA-256 digest.
 */
const ID_PATTERN = /^[0-9a-f]{64}$/

/**
 * Read-only view of the BFF-owned artifact directory. The host never writes,
 * never lists and never follows a stored `meta.json`: it answers exactly one
 * question, "are there bytes for this id?".
 */
export class ArtifactReader {
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  /** The stored document, or `null` when the id is unshaped or absent. */
  async read(id: string): Promise<Buffer | null> {
    if (!ID_PATTERN.test(id)) return null
    try {
      return await readFile(join(this.dir, id, "index.html"))
    } catch {
      // A missing directory, a missing file, a permission error: all 404.
      return null
    }
  }
}
