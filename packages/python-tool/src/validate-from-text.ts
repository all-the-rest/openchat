import {
  MAX_BLOCKS,
  MAX_BLOCK_TEXT_CHARS,
  MAX_CELL_CHARS,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  MAX_TITLE,
} from "./limits"
import type { Block } from "./markdown"
import { parseMarkdown } from "./markdown"
import { templateParts } from "./template"
import type { ValidationResult } from "./validate"

/**
 * Argument validation for `docx_from_text` (issue #22). Both input shapes —
 * typed `blocks` and the Markdown subset — end up in the same block list and
 * pass the same caps, so the renderer can never see a document the validator
 * did not bound: 500 blocks, 20 000 characters, 50 table rows, 8 columns.
 * Errors stay one line with a field and a number, never a value or a trace.
 */

export interface DocxFromTextInput {
  /** Artifact title; derived from the first block when the caller omits one. */
  title: string
  /** Rendered as the document heading; present only when the caller asked. */
  documentTitle?: string
  /** `<sessionID>/files/<name>.docx`, relative to WORKDIR/chats. */
  chatPath: string
  /** The name the chat file starts under (collision suffixing may change it). */
  filename: string
  blocks: Block[]
}

type Field<T> = { ok: true; value: T } | { ok: false; error: string }

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const KINDS = ["heading", "paragraph", "bullet", "code", "table"] as const
const KIND_LIST = "heading, paragraph, bullet, code or table"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function bad(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

function characters(value: string): number {
  return [...value].length
}

function readTitle(value: unknown): Field<string | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (typeof value !== "string") return bad("title: must be a string")
  const trimmed = value.trim()
  if (trimmed.length === 0) return bad("title: must not be empty")
  if (CONTROL_CHARACTERS.test(trimmed)) return bad("title: contains a control character")
  const length = characters(trimmed)
  if (length > MAX_TITLE) return bad(`title: ${length} characters > ${MAX_TITLE}`)
  return { ok: true, value: trimmed }
}

function readChatPath(value: unknown): Field<{ chatPath: string; filename: string }> {
  if (typeof value !== "string") return bad("chatPath: must be a string")
  const parts = templateParts(value)
  if (!parts || !parts.name.toLowerCase().endsWith(".docx")) {
    return bad("chatPath: use <sessionID>/files/<name>.docx")
  }
  return { ok: true, value: { chatPath: value, filename: parts.name } }
}

function readTableCell(value: unknown, field: string): Field<string> {
  if (typeof value !== "string") return bad(`${field}: must be a plain string`)
  if (CONTROL_CHARACTERS.test(value)) return bad(`${field}: contains a control character`)
  if (value.includes("\n") || value.includes("\t")) {
    return bad(`${field}: must not contain a line break`)
  }
  if (value.length > MAX_CELL_CHARS) {
    return bad(`${field}: ${value.length} characters > ${MAX_CELL_CHARS}`)
  }
  return { ok: true, value }
}

function readTableRows(value: unknown, field: string): Field<string[][]> {
  if (!Array.isArray(value)) return bad(`${field}: must be an array`)
  if (value.length === 0) return bad(`${field}: at least 1 entry required`)
  if (value.length > MAX_TABLE_ROWS) return bad(`${field}: ${value.length} rows > ${MAX_TABLE_ROWS}`)

  const rows: string[][] = []
  let width = 0
  for (let index = 0; index < value.length; index += 1) {
    const row = value[index]
    if (!Array.isArray(row)) return bad(`${field}[${index}]: must be an array`)
    if (row.length === 0) return bad(`${field}[${index}]: at least 1 entry required`)
    if (row.length > MAX_TABLE_COLUMNS) {
      return bad(`${field}[${index}]: ${row.length} cells > ${MAX_TABLE_COLUMNS}`)
    }
    if (width === 0) width = row.length
    if (row.length !== width) {
      return bad(`${field}[${index}]: expected ${width} cells, got ${row.length}`)
    }

    const cells: string[] = []
    for (let column = 0; column < row.length; column += 1) {
      const cell = readTableCell(row[column], `${field}[${index}][${column}]`)
      if (!cell.ok) return cell
      cells.push(cell.value)
    }
    rows.push(cells)
  }
  return { ok: true, value: rows }
}

function readText(value: unknown, field: string, multiline: boolean): Field<string> {
  if (typeof value !== "string") return bad(`${field}: must be a plain string`)
  if (value.trim().length === 0) return bad(`${field}: must not be empty`)
  if (CONTROL_CHARACTERS.test(value)) return bad(`${field}: contains a control character`)
  if (!multiline && (value.includes("\n") || value.includes("\t"))) {
    return bad(`${field}: must not contain a line break`)
  }
  return { ok: true, value }
}

function readBlock(value: unknown, index: number): Field<{ block: Block; characters: number }> {
  const field = `blocks[${index}]`
  if (!isRecord(value)) return bad(`${field}: must be an object`)
  const kind = value.kind
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) {
    return bad(`${field}.kind: must be ${KIND_LIST}`)
  }

  if (kind === "table") {
    const rows = readTableRows(value.rows, `${field}.rows`)
    if (!rows.ok) return rows
    const cells = rows.value.reduce(
      (total, row) => total + row.reduce((sum, cell) => sum + characters(cell), 0),
      0,
    )
    return { ok: true, value: { block: { kind: "table", rows: rows.value }, characters: cells } }
  }

  const text = readText(value.text, `${field}.text`, kind === "code")
  if (!text.ok) return text
  if (kind === "heading") {
    const level = value.level
    if (level !== 1 && level !== 2 && level !== 3) return bad(`${field}.level: must be 1, 2 or 3`)
    return {
      ok: true,
      value: {
        block: { kind: "heading", level, text: text.value },
        characters: characters(text.value),
      },
    }
  }

  const simple = kind as "paragraph" | "bullet" | "code"
  return {
    ok: true,
    value: { block: { kind: simple, text: text.value }, characters: characters(text.value) },
  }
}

function readBlocks(value: unknown): Field<Block[]> {
  if (!Array.isArray(value)) return bad("blocks: must be an array")
  if (value.length === 0) return bad("blocks: at least 1 entry required")
  if (value.length > MAX_BLOCKS) return bad(`blocks: ${value.length} entries > ${MAX_BLOCKS}`)

  const blocks: Block[] = []
  let total = 0
  for (let index = 0; index < value.length; index += 1) {
    const checked = readBlock(value[index], index)
    if (!checked.ok) return checked
    blocks.push(checked.value.block)
    total += checked.value.characters
  }
  if (total > MAX_BLOCK_TEXT_CHARS) {
    return bad(`blocks: ${total} characters > ${MAX_BLOCK_TEXT_CHARS}`)
  }
  return { ok: true, value: blocks }
}

function derivedTitle(blocks: Block[]): string {
  for (const block of blocks) {
    const text = block.kind === "table" ? (block.rows[0] ?? []).join(" ") : block.text
    const trimmed = text.trim()
    if (trimmed.length > 0) return [...trimmed].slice(0, MAX_TITLE).join("")
  }
  return "Document"
}

export function validateDocxFromText(input: Record<string, unknown>): ValidationResult {
  const hasBlocks = input.blocks !== undefined && input.blocks !== null
  const hasMarkdown = input.markdown !== undefined && input.markdown !== null
  if (hasBlocks === hasMarkdown) return bad("input: pass exactly one of blocks or markdown")

  const chatPath = readChatPath(input.chatPath)
  if (!chatPath.ok) return chatPath
  const title = readTitle(input.title)
  if (!title.ok) return title

  let candidate: unknown = input.blocks
  if (hasMarkdown) {
    if (typeof input.markdown !== "string") return bad("markdown: must be a string")
    if (input.markdown.trim().length === 0) return bad("markdown: must not be empty")
    const length = characters(input.markdown)
    if (length > MAX_BLOCK_TEXT_CHARS) {
      return bad(`markdown: ${length} characters > ${MAX_BLOCK_TEXT_CHARS}`)
    }
    const parsed = parseMarkdown(input.markdown)
    if (parsed.length === 0) return bad("markdown: no supported content")
    candidate = parsed
  }

  const blocks = readBlocks(candidate)
  if (!blocks.ok) return blocks

  return {
    ok: true,
    value: {
      name: "docx_from_text",
      value: {
        title: title.value ?? derivedTitle(blocks.value),
        ...(title.value === undefined ? {} : { documentTitle: title.value }),
        chatPath: chatPath.value.chatPath,
        filename: chatPath.value.filename,
        blocks: blocks.value,
      },
    },
  }
}
