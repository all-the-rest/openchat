import type { ArtifactInternalCreateRequest, ArtifactWriteReceipt } from "@openchat/contracts"
import { postDocument } from "@openchat/artifact-tool/bff"
import type { BffOptions } from "@openchat/artifact-tool/bff"
import { buildFileCard, mimeForDocument } from "./card"
import type { DocumentsClient } from "./documents-client"
import { errorText } from "./errors"
import type { ProcessRunner } from "./process"
import { runPython } from "./runner"
import type { PythonScript } from "./runner"
import { readTemplate } from "./template"
import {
  kib,
  validateDocxFill,
  validateDocumentExtract,
  validateDocumentsFill,
  validatePdfFromMarkdown,
  validateReadDocument,
  validateXlsxWrite,
} from "./validate"

/**
 * The four typed document tools. Each one validates its arguments, runs one
 * fixed Python script through the guard in `runner.ts`, and stores the result
 * through the existing artifact write path (`POST /internal/artifacts`).
 * `read_document` returns extracted text instead of storing a file.
 */

export interface FileSink {
  store(
    document: ArtifactInternalCreateRequest,
  ): Promise<{ ok: true; receipt: ArtifactWriteReceipt } | { ok: false; error: string }>
}

/** The default sink: the same bearer-authenticated route the app tool uses. */
export function artifactSink(options: BffOptions): FileSink {
  return { store: (document) => postDocument(options, document) }
}

export interface DocumentToolDeps {
  /** Interpreter command or absolute path (`OPENCHAT_PYTHON`). */
  python: string
  sink: FileSink
  /** Root of `chats/<session>/files`; only templates below it can be read. */
  workspaceDir?: string
  /** Client for the headless documents service. */
  documents?: DocumentsClient
  runProcess?: ProcessRunner
  scriptDir?: URL
  tempRoot?: string
  timeoutMs?: number
}

export type ToolResult = { ok: true; text: string } | { ok: false; error: string }

export interface ToolSpec {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
}

const RETRY =
  "If the tool rejects the input, fix exactly what the message names and retry at most twice; after that, explain the document in text instead."

export const DOCUMENT_TOOLS: readonly ToolSpec[] = [
  {
    name: "docx_fill",
    title: "Create or fill a Word document",
    description: [
      "Create a .docx from a title and paragraphs, or fill an uploaded .docx template.",
      "For a template, pass its bytes as base64 in `template` and a `values` map:",
      "every `{{name}}` placeholder in body paragraphs, tables, headers and footers is replaced.",
      "Without a template, `paragraphs` become the body and the title is the heading.",
      "Macros are never executed; a macro-enabled document is rejected.",
      "Never pass a file path: bytes travel as base64.",
      RETRY,
      "Returns { artifactID, title, fileName, bytes }.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Plain-text title, at most 120 characters." },
        paragraphs: {
          type: "array",
          items: { type: "string" },
          description: "Body paragraphs when no template is given; at most 200 entries.",
        },
        template: {
          type: "string",
          description: "Optional base64 .docx template, at most 8 MiB decoded.",
        },
        values: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Placeholder values for `{{key}}`; keys are letters, digits, dot, dash or underscore.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "xlsx_write",
    title: "Write an Excel workbook",
    description: [
      "Write one .xlsx with up to 10 sheets, 5000 rows per sheet and 100 cells per row.",
      "Cell types are preserved: numbers stay numeric, booleans stay booleans, null is an empty cell.",
      "A string that starts with `=` is stored as a formula; use it for simple formulas such as `=SUM(B2:B9)`.",
      "Sheet names are 1-31 characters and may not contain []:*?/\\.",
      "Never pass a file path.",
      RETRY,
      "Returns { artifactID, title, fileName, bytes }.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Plain-text title, at most 120 characters." },
        sheets: {
          type: "array",
          description: "One to ten sheets.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Sheet name, 1-31 characters." },
              rows: {
                type: "array",
                items: { type: "array", items: { type: ["string", "number", "boolean", "null"] } },
                description: "Rows of typed cells.",
              },
            },
            required: ["name", "rows"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "sheets"],
      additionalProperties: false,
    },
  },
  {
    name: "pdf_from_markdown",
    title: "Render Markdown as a PDF",
    description: [
      "Render Markdown as a selectable-text PDF with reportlab's built-in fonts.",
      "Supported: headings, paragraphs, bullet lists, fenced code blocks, **bold**, *italic*",
      "and `code` spans; links become `text (url)`. Text is latin-1 only until embedded fonts land.",
      "No network and no font download. Never pass a file path.",
      RETRY,
      "Returns { artifactID, title, fileName, bytes }.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Document title and PDF metadata, at most 120 characters." },
        markdown: { type: "string", description: "Markdown source, at most 200000 characters." },
      },
      required: ["title", "markdown"],
      additionalProperties: false,
    },
  },
  {
    name: "read_document",
    title: "Read a document as Markdown text",
    description: [
      "Extract text from a .docx, .xlsx or .pdf as Markdown for the agent.",
      "Pass the file name in `name` and its bytes as base64 in `base64` (at most 8 MiB decoded).",
      "DOCX: paragraphs, tables and headers/footers. XLSX: every sheet as a Markdown table.",
      "PDF: the text layer per page; scanned pages without text are reported as empty.",
      "Never pass a file path. Returns the extracted text, truncated at 200000 characters.",
      RETRY,
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "One file name ending in .docx, .xlsx or .pdf." },
        base64: { type: "string", description: "The document bytes as base64, at most 8 MiB decoded." },
      },
      required: ["name", "base64"],
      additionalProperties: false,
    },
  },
  {
    name: "documents_fill",
    title: "Fill an uploaded Word template and export a PDF",
    description: [
      "Fill a .docx or .dotx template that was uploaded into a chat and download both outputs.",
      "Pass `templatePath` as `<sessionID>/files/<file>` inside WORKSPACE_DIR/chats — never an absolute path.",
      "The template is read with symlinks refused and a size cap; macro-enabled files are rejected.",
      "`values` are Jinja placeholders from the template; scalars, lists and nested maps are supported for `{% for %}` loops.",
      "The filled DOCX and its LibreOffice PDF are stored as two downloadable file cards; both file names are returned.",
      "Rendering is faithful to the template's layout but LibreOffice may differ from Word on exotic fields.",
      "Never pass a template as raw bytes and never pass a path outside WORKSPACE_DIR/chats.",
      RETRY,
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        templatePath: {
          type: "string",
          description: "Relative path `chats/<sessionID>/files/<name>.docx|.dotx` under WORKSPACE_DIR.",
        },
        values: {
          type: "object",
          description: "Placeholder values; keys are letters, digits, dot, dash or underscore.",
        },
        name: {
          type: "string",
          description: "Optional base name for the two outputs, at most 120 characters.",
        },
      },
      required: ["templatePath", "values"],
      additionalProperties: false,
    },
  },
  {
    name: "document_extract",
    title: "Extract any document as Markdown",
    description: [
      "Convert an uploaded document to Markdown with the markitdown service.",
      "Use this for PPTX, HTML and other formats that `read_document` does not read locally.",
      "Pass the file name in `name` and its bytes as base64 in `base64` (at most 8 MiB decoded).",
      "DOCX, XLSX and PDF are still read locally by `read_document`; this tool uses the service.",
      "Never pass a file path. Returns text truncated at 200000 characters.",
      RETRY,
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "One file name ending in a supported extension." },
        base64: { type: "string", description: "The document bytes as base64, at most 8 MiB decoded." },
      },
      required: ["name", "base64"],
      additionalProperties: false,
    },
  },
] as const

export const DOCUMENT_TOOL_NAMES = DOCUMENT_TOOLS.map((tool) => tool.name)

function formatReceipt(
  fileName: string,
  mime: string,
  receipt: ArtifactWriteReceipt,
): string {
  return [
    `Stored "${fileName}" (${mime}, ${kib(receipt.bytes)} KiB) as artifact ${receipt.artifactID}.`,
    "The artifact is one self-contained HTML document carrying the generated file.",
  ].join("\n")
}

async function runScript(
  script: PythonScript,
  payload: Record<string, unknown>,
  files: Record<string, Uint8Array> | undefined,
  deps: DocumentToolDeps,
) {
  return runPython(
    { script, payload, ...(files ? { files } : {}) },
    {
      python: deps.python,
      ...(deps.runProcess ? { runProcess: deps.runProcess } : {}),
      ...(deps.scriptDir ? { scriptDir: deps.scriptDir } : {}),
      ...(deps.tempRoot ? { tempRoot: deps.tempRoot } : {}),
      ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
    },
  )
}

async function storeFile(
  title: string,
  file: { name: string; bytes: Uint8Array },
  deps: DocumentToolDeps,
): Promise<ToolResult> {
  const card = buildFileCard({ title, fileName: file.name, bytes: file.bytes })
  if (!card.ok) return { ok: false, error: card.error }
  const stored = await deps.sink.store({ title, html: card.html })
  if (!stored.ok) return { ok: false, error: stored.error }
  return { ok: true, text: formatReceipt(file.name, mimeForDocument(file.name), stored.receipt) }
}

export async function callDocumentTool(
  name: string,
  input: unknown,
  deps: DocumentToolDeps,
): Promise<ToolResult> {
  if (name === "docx_fill") {
    const validated = validateDocxFill(input)
    if (!validated.ok) return validated
    const { title, paragraphs, template, values } = validated.value
    const script = await runScript(
      "docx_fill",
      { title, paragraphs, values },
      template ? { "template.docx": template } : undefined,
      deps,
    )
    if (!script.ok) return { ok: false, error: script.message }
    if (!script.value.file) return { ok: false, error: "internal: the document tool returned no file" }
    return storeFile(title, script.value.file, deps)
  }

  if (name === "xlsx_write") {
    const validated = validateXlsxWrite(input)
    if (!validated.ok) return validated
    const { title, sheets } = validated.value
    const script = await runScript("xlsx_write", { title, sheets }, undefined, deps)
    if (!script.ok) return { ok: false, error: script.message }
    if (!script.value.file) return { ok: false, error: "internal: the document tool returned no file" }
    return storeFile(title, script.value.file, deps)
  }

  if (name === "pdf_from_markdown") {
    const validated = validatePdfFromMarkdown(input)
    if (!validated.ok) return validated
    const { title, markdown } = validated.value
    const script = await runScript("pdf_from_markdown", { title, markdown }, undefined, deps)
    if (!script.ok) return { ok: false, error: script.message }
    if (!script.value.file) return { ok: false, error: "internal: the document tool returned no file" }
    return storeFile(title, script.value.file, deps)
  }

  if (name === "read_document") {
    const validated = validateReadDocument(input)
    if (!validated.ok) return validated
    const { name: fileName, kind, bytes } = validated.value
    const script = await runScript(
      "read_document",
      { name: fileName, kind },
      { [`input.${kind}`]: bytes },
      deps,
    )
    if (!script.ok) return { ok: false, error: script.message }
    const text = script.value.text?.trim() ?? ""
    if (text.length === 0) {
      return { ok: false, error: "unsupported: the document contains no extractable text" }
    }
    return { ok: true, text }
  }

  if (name === "documents_fill") {
    const validated = validateDocumentsFill(input)
    if (!validated.ok) return validated
    const client = deps.documents
    if (!client) return { ok: false, error: errorText("service_unavailable") }
    const workspaceDir = deps.workspaceDir
    if (!workspaceDir) return { ok: false, error: errorText("invalid_path") }
    const template = await readTemplate(workspaceDir, validated.value.templatePath)
    if (!template.ok) return { ok: false, error: errorText(template.code) }
    const filled = await client.fill({
      template: Buffer.from(template.bytes).toString("base64"),
      values: validated.value.values,
      name: validated.value.name,
    })
    if (!filled.ok) return filled
    const docx = await storeFile(validated.value.name, {
      name: filled.value.docxName,
      bytes: filled.value.docx,
    }, deps)
    if (!docx.ok) return docx
    const pdf = await storeFile(validated.value.name, {
      name: filled.value.pdfName,
      bytes: filled.value.pdf,
    }, deps)
    if (!pdf.ok) return pdf
    return {
      ok: true,
      text: [
        docx.text,
        pdf.text,
        `Filled files: ${filled.value.docxName}, ${filled.value.pdfName}.`,
      ].join("\n"),
    }
  }

  if (name === "document_extract") {
    const validated = validateDocumentExtract(input)
    if (!validated.ok) return validated
    const client = deps.documents
    if (!client) return { ok: false, error: errorText("service_unavailable") }
    const extracted = await client.extract({
      name: validated.value.name,
      base64: Buffer.from(validated.value.bytes).toString("base64"),
    })
    if (!extracted.ok) return extracted
    const text = extracted.value.markdown.trim()
    if (text.length === 0) return { ok: false, error: errorText("empty_document") }
    return { ok: true, text }
  }

  return { ok: false, error: "internal: unknown tool" }
}
