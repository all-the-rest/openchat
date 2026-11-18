import type { ArtifactInternalCreateRequest } from "@openchat/contracts"
import { postDocument } from "./bff"
import type { BffOptions } from "./bff"
import { ESBUILD_VERSION, PREACT_VERSION, compileModule } from "./compile"
import { buildDocument } from "./shell"
import { validateAppInput } from "./validate"

/**
 * `openchat_app_write`: validate, compile, assemble the document and store it
 * through the BFF. One function, no I/O of its own beyond the injected fetch.
 */

export interface WriteSuccess {
  /** SHA-256 of the stored document, 64 lowercase hex characters. */
  artifactID: string
  title: string
  bytes: number
  /** Non-blocking compiler messages; omitted when there are none. */
  warnings?: string[]
}

export type WriteResult = { ok: true; value: WriteSuccess } | { ok: false; error: string }

export type ToolDeps = BffOptions

export async function writeApp(input: unknown, deps: ToolDeps): Promise<WriteResult> {
  const validation = validateAppInput(input)
  if (!validation.ok) return { ok: false, error: validation.error }
  const { title, code, css } = validation.value

  const compiled = await compileModule(code)
  if ("error" in compiled) return { ok: false, error: compiled.error }

  const html = buildDocument({
    title,
    css,
    script: compiled.script,
    tools: { esbuild: ESBUILD_VERSION, preact: PREACT_VERSION },
  })
  const body: ArtifactInternalCreateRequest = { title, html }
  const posted = await postDocument(deps, body)
  if (!posted.ok) return { ok: false, error: posted.error }

  const { artifactID, title: storedTitle, bytes } = posted.receipt
  return {
    ok: true,
    value: {
      artifactID,
      title: storedTitle,
      bytes,
      ...(compiled.warnings.length > 0 ? { warnings: compiled.warnings } : {}),
    },
  }
}
