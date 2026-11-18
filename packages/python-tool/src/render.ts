import { MAX_FILE_BYTES } from "./limits"

/**
 * A document tool's output is still one artifact document. The existing store,
 * route and viewer know exactly one format: a self-contained HTML page. A
 * generated DOCX/XLSX/PDF therefore travels as an embedded JSON payload inside
 * that page, not as a second artifact kind. The payload is base64, so it can
 * never terminate the script element; `read_document` extracts the same
 * payload and the opt-in integration test compares the bytes.
 */

export interface EmbeddedFile {
  filename: string
  mediaType: string
  data: Buffer
}

export const PAYLOAD_ID = "openchat-file"

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,159}$/
const MEDIA_TYPE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character)
}

function kib(bytes: number): string {
  return `${Math.max(1, Math.ceil(bytes / 1024))} KiB`
}

export function buildFileArtifact(input: {
  title: string
  filename: string
  mediaType: string
  data: Buffer
}): string {
  const data = input.data.toString("base64")
  const payload = JSON.stringify({
    filename: input.filename,
    mediaType: input.mediaType,
    bytes: input.data.byteLength,
    data,
  }).replace(/</g, "\\u003c")
  return `<!doctype html><html lang="en" data-oc="3" data-openchat-file="1"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(input.title)}</title>
<style>
:root{--bg:#ffffff;--fg:#14161a;--muted:#5b6472;--accent:#2563eb;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#14161a;--fg:#f2f4f8;--muted:#a3adbb;--accent:#7aa2ff}}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
main{max-width:38rem;margin:0 auto}
h1{font-size:1.25rem;margin:0 0 .5rem}
p{margin:.35rem 0;color:var(--muted)}
.file{display:inline-block;margin-top:1rem;padding:.6rem .9rem;border:1px solid var(--muted);border-radius:8px;color:var(--accent);font-weight:600}
</style>
</head><body><main>
<h1>${escapeHtml(input.filename)}</h1>
<p>${escapeHtml(input.mediaType)} &middot; ${kib(input.data.byteLength)}</p>
<p>This artifact carries <strong>${escapeHtml(input.filename)}</strong> as an embedded file payload.</p>
<span class="file">${escapeHtml(input.filename)}</span>
<script type="application/json" id="${PAYLOAD_ID}">${payload}</script>
</main></body></html>
`
}

/** `null` for any page that does not carry a well-formed embedded file. */
export function parseFileArtifact(html: string): EmbeddedFile | null {
  const match = new RegExp(
    `<script type="application/json" id="${PAYLOAD_ID}">([\\s\\S]*?)</script>`,
  ).exec(html)
  const raw = match?.[1]
  if (raw === undefined) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const { filename, mediaType, data } = record
  if (typeof filename !== "string" || !FILE_NAME.test(filename)) return null
  if (typeof mediaType !== "string" || !MEDIA_TYPE.test(mediaType)) return null
  if (typeof data !== "string" || data.length === 0 || data.length % 4 !== 0) return null
  if (!BASE64.test(data)) return null

  const bytes = Buffer.from(data, "base64")
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES) return null
  return { filename, mediaType, data: bytes }
}
