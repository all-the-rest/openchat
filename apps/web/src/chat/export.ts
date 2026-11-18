import type { Message, ToolStatus } from "@openchat/contracts"

/**
 * Markdown export of the transcript the browser already holds (spec 02, issue
 * #8). There is no server round-trip: the builder only reads loaded state, so
 * an export works while the host is down and never re-fetches a transcript.
 */
export interface ExportLabels {
  date: string
  user: string
  assistant: string
  system: string
  tool: string
  artifact: string
  artifactNote: string
  untitled: string
}

export interface ChatExportInput {
  title: string
  created?: number
  messages: readonly Message[]
  labels: ExportLabels
  toolStatus: (status: ToolStatus) => string
}

const SLUG_MAX = 60
const TRANSLITERATION: Record<string, string> = {
  ä: "ae",
  ö: "oe",
  ü: "ue",
  ß: "ss",
  æ: "ae",
  ø: "oe",
  å: "aa",
}

/** ISO calendar date in UTC; an unparseable timestamp yields no date line. */
export function isoDate(created: number): string | null {
  const date = new Date(created)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10)
}

/**
 * Escapes what could turn transcript text into document structure: backslash
 * first, then a block marker at the start of a line (heading, quote, list,
 * ordered item) and a code fence anywhere. Inline emphasis stays readable.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/^(\s*)(#{1,6}|>|[-+*])(\s)/gm, "$1\\$2$3")
    .replace(/^(\s*)(\d+)([.)])(\s)/gm, "$1$2\\$3$4")
    .replace(/```/g, "\\`\\`\\`")
}

/** A heading and a filename are single lines: fold whitespace, keep text. */
function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

/**
 * Lower-case, ASCII-only slug of the chat title. Umlauts transliterate instead
 * of losing a letter; everything else that is not `a-z0-9` becomes a dash.
 * Untitled chats share the stable fallback `chat` so downloads never collide
 * on a filesystem-hostile name.
 */
export function slugifyTitle(title: string): string {
  const folded = singleLine(title)
    .toLowerCase()
    .replace(/[äöüßæøå]/g, (character) => TRANSLITERATION[character] ?? character)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return [...folded].slice(0, SLUG_MAX).join("").replace(/-+$/g, "")
}

export function chatFilename(title: string): string {
  return `${slugifyTitle(title) || "chat"}.md`
}

function textParts(message: Message): string[] {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text.trim())
    .filter((text) => text.length > 0)
}

function detailLines(input: ChatExportInput, message: Message): string[] {
  const lines: string[] = []
  for (const part of message.parts) {
    if (part.type === "tool") {
      lines.push(`- ${input.labels.tool}: ${singleLine(part.name)} (${input.toolStatus(part.status)})`)
    } else if (part.type === "artifact") {
      lines.push(
        `- ${input.labels.artifact}: ${singleLine(part.title)} — ${input.labels.artifactNote}`,
      )
    }
  }
  return lines
}

function headingRole(input: ChatExportInput, message: Message): string {
  if (message.role === "user") return input.labels.user
  if (message.role === "assistant") return input.labels.assistant
  return input.labels.system
}

/**
 * The exact document a download contains. Tool bodies, reasoning and error
 * internals stay out: the export lists a tool's name and status, and an
 * artifact's title with the note that its files live in the chat.
 */
export function buildChatMarkdown(input: ChatExportInput): string {
  const title = singleLine(input.title) || input.labels.untitled
  const blocks: string[] = [`# ${title.replace(/\\/g, "\\\\")}`]

  const date = typeof input.created === "number" ? isoDate(input.created) : null
  if (date) blocks.push(`${input.labels.date}: ${date}`)

  for (const message of input.messages) {
    const texts = textParts(message)
    const details = detailLines(input, message)
    if (texts.length === 0 && details.length === 0) continue

    const section = [`## ${headingRole(input, message)}`]
    if (texts.length > 0) section.push(texts.map(escapeMarkdown).join("\n\n"))
    if (details.length > 0) section.push(details.join("\n"))
    blocks.push(section.join("\n\n"))
  }

  return `${blocks.join("\n\n")}\n`
}
