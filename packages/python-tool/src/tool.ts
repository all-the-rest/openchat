import type { BffOptions } from "@openchat/artifact-tool/bff"
import { getDocument, postDocument } from "@openchat/artifact-tool/bff"
import type { ArtifactInternalCreateRequest } from "@openchat/contracts"
import { writeChatOutputs } from "./chat-output"
import type { DocumentsClient } from "./documents-client"
import { ARTIFACT_MAX_BYTES, MAX_FILE_BYTES, MAX_TITLE, READ_PREVIEW_BYTES } from "./limits"
import { buildFileArtifact, parseFileArtifact } from "./render"
import type { PythonRunner } from "./runner"
import { readTemplate } from "./template"
import { validateTool } from "./validate"

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const PDF_MIME = "application/pdf"

/**
 * `runDocumentTool`: validate, run one fixed Python script, wrap its file in
 * the one artifact format and store it through the internal route. No path
 * from the model reaches the filesystem; an input document is read from the
 * artifact store by id, never from a caller-supplied path.
 */

export interface ToolDeps extends BffOptions {
  runner: PythonRunner
  /** Root of `WORKSPACE_DIR/chats`; required by the two chat-file tools. */
  workspaceDir?: string
  /** Client of the headless LibreOffice service. */
  documents?: DocumentsClient
}

export interface ToolSuccess {
  /** SHA-256 of the stored HTML document. */
  artifactID: string
  title: string
  /** The generated file's name, e.g. `report.pdf`. */
  filename: string
  mediaType: string
  /** Size of the stored artifact document. */
  bytes: number
  /** Size of the embedded file. */
  fileBytes: number
  /** `read_document` only: the beginning of the extracted Markdown. */
  preview?: string
  /** Chat-file tools only: names written beside the uploaded template. */
  files?: string[]
}

export type ToolResult =
  | { ok: true; value: ToolSuccess }
  | { ok: false; error: string }

function previewOf(data: Buffer): string {
  if (data.byteLength <= READ_PREVIEW_BYTES) return data.toString("utf8")
  return `${data.subarray(0, READ_PREVIEW_BYTES).toString("utf8")}\n…`
}

async function storeFile(
  deps: ToolDeps,
  title: string,
  filename: string,
  mediaType: string,
  file: Buffer,
  preview?: string,
): Promise<ToolResult> {
  if (file.byteLength > MAX_FILE_BYTES) {
    return { ok: false, error: "size: the generated document exceeds the artifact limit" }
  }
  const cappedTitle = [...title].slice(0, MAX_TITLE).join("")
  const html = buildFileArtifact({ title: cappedTitle, filename, mediaType, data: file })
  if (Buffer.byteLength(html, "utf8") > ARTIFACT_MAX_BYTES) {
    return { ok: false, error: "size: the wrapped document exceeds the artifact limit" }
  }

  const body: ArtifactInternalCreateRequest = { title: cappedTitle, html }
  const posted = await postDocument(deps, body)
  if (!posted.ok) return { ok: false, error: posted.error }

  return {
    ok: true,
    value: {
      artifactID: posted.receipt.artifactID,
      title: posted.receipt.title,
      filename,
      mediaType,
      bytes: posted.receipt.bytes,
      fileBytes: file.byteLength,
      ...(preview === undefined ? {} : { preview }),
    },
  }
}

export async function runDocumentTool(
  name: string,
  args: unknown,
  deps: ToolDeps,
): Promise<ToolResult> {
  const validation = validateTool(name, args)
  if (!validation.ok) return { ok: false, error: validation.error }
  const call = validation.value

  switch (call.name) {
    case "docx_fill": {
      const input = call.value
      if (input.templateArtifactID === undefined) {
        const run = await deps.runner("docx_fill", {
          filename: input.outputName,
          paragraphs: input.paragraphs ?? [],
          values: input.values,
        })
        if (!run.ok) return run
        return storeFile(
          deps,
          input.title,
          run.value.filename,
          run.value.mediaType,
          run.value.data,
        )
      }

      const source = await getDocument(deps, input.templateArtifactID)
      if (!source.ok) return source
      const embedded = parseFileArtifact(source.html)
      if (!embedded) {
        return { ok: false, error: "unsupported: the source artifact does not carry a document file" }
      }
      if (!embedded.filename.toLowerCase().endsWith(".docx")) {
        return { ok: false, error: "unsupported: the source artifact is not a .docx file" }
      }
      const run = await deps.runner("docx_fill", {
        filename: input.outputName,
        template: embedded.data.toString("base64"),
        values: input.values,
      })
      if (!run.ok) return run
      return storeFile(deps, input.title, run.value.filename, run.value.mediaType, run.value.data)
    }

    case "xlsx_write": {
      const input = call.value
      const run = await deps.runner("xlsx_write", {
        filename: input.outputName,
        sheet: input.sheet,
        headers: input.headers,
        rows: input.rows,
        formulas: input.formulas,
      })
      if (!run.ok) return run
      return storeFile(deps, input.title, run.value.filename, run.value.mediaType, run.value.data)
    }

    case "pdf_from_markdown": {
      const input = call.value
      const run = await deps.runner("pdf_from_markdown", {
        filename: input.outputName,
        title: input.title,
        markdown: input.markdown,
      })
      if (!run.ok) return run
      return storeFile(deps, input.title, run.value.filename, run.value.mediaType, run.value.data)
    }

    case "read_document": {
      const input = call.value
      const source = await getDocument(deps, input.sourceArtifactID)
      if (!source.ok) return source
      const embedded = parseFileArtifact(source.html)
      if (!embedded) {
        return { ok: false, error: "unsupported: the source artifact does not carry a document file" }
      }
      const run = await deps.runner("read_document", {
        filename: embedded.filename,
        mediaType: embedded.mediaType,
        data: embedded.data.toString("base64"),
      })
      if (!run.ok) return run
      const title = input.title ?? `${embedded.filename} (Markdown)`
      return storeFile(
        deps,
        title,
        run.value.filename,
        run.value.mediaType,
        run.value.data,
        previewOf(run.value.data),
      )
    }

    case "documents_fill": {
      const input = call.value
      const service = deps.documents
      const workspaceDir = deps.workspaceDir
      if (!service) {
        return { ok: false, error: "service: the documents service is unreachable; check DOCUMENTS_URL" }
      }
      if (!workspaceDir) return { ok: false, error: "templatePath: WORKSPACE_DIR is not configured" }
      const template = await readTemplate(workspaceDir, input.templatePath)
      if (!template.ok) return { ok: false, error: template.error }
      const filled = await service.fill({
        template: Buffer.from(template.bytes).toString("base64"),
        values: input.values,
        name: input.name ?? "document",
      })
      if (!filled.ok) return filled
      const written = await writeChatOutputs(workspaceDir, input.templatePath, input.name, [
        { name: filled.value.docxName, bytes: filled.value.docx },
        { name: filled.value.pdfName, bytes: filled.value.pdf },
      ])
      if (!written.ok) return { ok: false, error: written.error }
      const title = input.name ?? "Filled template"
      const docx = await storeFile(deps, title, filled.value.docxName, DOCX_MIME, Buffer.from(filled.value.docx))
      if (!docx.ok) return docx
      const pdf = await storeFile(deps, title, filled.value.pdfName, PDF_MIME, Buffer.from(filled.value.pdf))
      if (!pdf.ok) return pdf
      return { ok: true, value: { ...docx.value, files: written.names } }
    }

    case "documents_convert": {
      const input = call.value
      const service = deps.documents
      const workspaceDir = deps.workspaceDir
      if (!service) {
        return { ok: false, error: "service: the documents service is unreachable; check DOCUMENTS_URL" }
      }
      if (!workspaceDir) return { ok: false, error: "templatePath: WORKSPACE_DIR is not configured" }
      const template = await readTemplate(workspaceDir, input.templatePath)
      if (!template.ok) return { ok: false, error: template.error }
      const converted = await service.convert({
        document: Buffer.from(template.bytes).toString("base64"),
        name: input.name ?? "document",
      })
      if (!converted.ok) return converted
      const written = await writeChatOutputs(workspaceDir, input.templatePath, input.name, [
        { name: converted.value.pdfName, bytes: converted.value.pdf },
      ])
      if (!written.ok) return { ok: false, error: written.error }
      const stored = await storeFile(
        deps,
        input.name ?? "Converted document",
        converted.value.pdfName,
        PDF_MIME,
        Buffer.from(converted.value.pdf),
      )
      if (!stored.ok) return stored
      return { ok: true, value: { ...stored.value, files: written.names } }
    }

    default:
      return { ok: false, error: "input: unknown tool" }
  }
}
