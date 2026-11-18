import { ARTIFACT_MAX_BYTES } from "@openchat/contracts"
import { BRIDGE_SCRIPT } from "@openchat/contracts/artifacts/bridge"
import { SHELL_CSS, escapeHtml } from "@openchat/artifact-tool/shell"

/**
 * The stored form of a generated document: one self-contained HTML artifact,
 * the only document format the artifact store accepts
 * (`ArtifactCreateRequest` is `{ title, html }`). The file bytes travel inside
 * it as a base64 `data:` URL, so the artifact id stays the SHA-256 of the one
 * stored document and no second store, layout or id scheme is introduced.
 *
 * The bridge script is included so the artifact iframe completes its
 * handshake and requests its height; without it the viewer would stay on the
 * loading cover. There is no app script: the card is static.
 */

const MIME_BY_EXTENSION: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
}

const CARD_CSS = `.file{display:grid;gap:8px}
.file h1{font-size:18px;line-height:1.3;margin:0;overflow-wrap:anywhere}
.file .meta,.file .note{margin:0;color:var(--muted);font-size:13px}
.file a{color:var(--accent);font-weight:600}`

export interface FileCardInput {
  title: string
  /** One safe file name; already validated by the caller. */
  fileName: string
  bytes: Uint8Array
}

export type FileCardResult = { ok: true; html: string } | { ok: false; error: string }

export function mimeForDocument(fileName: string): string {
  const extension = fileName.toLowerCase().split(".").pop() ?? ""
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream"
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KiB`
}

/**
 * Deterministic for identical input: no clock, no random id. A file whose card
 * would exceed the store's 1 MiB document cap is refused here, before the
 * write, with the stable `size:` message.
 */
export function buildFileCard(input: FileCardInput): FileCardResult {
  const mime = mimeForDocument(input.fileName)
  const base64 = Buffer.from(input.bytes).toString("base64")
  const name = escapeHtml(input.fileName)
  const data = `data:${mime};base64,${base64}`
  const html = `<!doctype html><html lang="en" data-oc="2"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(input.title)}</title>
<!-- openchat document card; shell 2; reportlab/python-docx/openpyxl output -->
<style>${SHELL_CSS}</style>
<style>${CARD_CSS}</style>
</head><body><div id="root"><main class="file">
<h1>${name}</h1>
<p class="meta">${escapeHtml(mime)} &middot; ${formatSize(input.bytes.byteLength)}</p>
<p><a href="${data}" download="${name}">Download ${name}</a></p>
<p class="note">The generated file is embedded in this artifact as a data URL.</p>
</main></div>
<script>${BRIDGE_SCRIPT}</script>
</body></html>
`
  if (Buffer.byteLength(html, "utf8") > ARTIFACT_MAX_BYTES) {
    return { ok: false, error: "size: the generated file is too large for one artifact" }
  }
  return { ok: true, html }
}
