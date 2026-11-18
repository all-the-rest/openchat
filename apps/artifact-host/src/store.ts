import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  ARTIFACT_DOCUMENT_FILE,
  ARTIFACT_MEDIA_FILE,
  isArtifactId,
} from "@openchat/contracts/artifacts/id"
import { artifactMime } from "@openchat/contracts/artifacts/mime"

/**
 * Read-only view of the BFF-owned artifact directory. The host never writes,
 * never lists and never follows a stored `meta.json`: it answers exactly one
 * question, "are there bytes for this id?".
 *
 * The id shape is checked before any path is built, so `..`, an absolute path
 * or a NUL byte cannot reach the filesystem. Only lowercase hex is accepted:
 * the BFF names directories after the SHA-256 digest.
 */
export class ArtifactReader {
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  /**
   * The stored bytes and their sniffed MIME, or `null` when the id is unshaped
   * or absent. The media name is tried first; a legacy directory only has the
   * HTML name. The host never reads `meta.json`, so a broken sidecar cannot
   * change the served type.
   */
  async read(id: string): Promise<{ bytes: Buffer; mime: string } | null> {
    if (!isArtifactId(id)) return null
    for (const file of [ARTIFACT_MEDIA_FILE, ARTIFACT_DOCUMENT_FILE]) {
      try {
        const bytes = await readFile(join(this.dir, id, file))
        return { bytes, mime: artifactMime(bytes) }
      } catch {
        // A missing directory, a missing file, a permission error: try the
        // other layout, then answer 404.
      }
    }
    return null
  }
}
