import type { Message, Role, ToolStatus } from "@openchat/contracts"
import type { MessageKey, MessageVars } from "../i18n"

/** The app's `t()` shape, so the builder stays pure and takes no React tree. */
export type Translator = (key: MessageKey, vars?: MessageVars) => string

export interface ExportInput {
  /** Already-resolved display title (the localized placeholder when empty). */
  title: string
  /** Already-formatted date string; formatting stays with the caller's locale. */
  date: string
  messages: readonly Message[]
}

const ROLE_HEADING: Record<Role, MessageKey> = {
  user: "export.roleUser",
  assistant: "export.roleAssistant",
  system: "export.roleSystem",
}

const TOOL_STATUS: Record<ToolStatus, MessageKey> = {
  queued: "tool.status.queued",
  running: "tool.status.running",
  success: "tool.status.success",
  error: "tool.status.error",
}

/** Escapes the two characters that could close a generated code span or link. */
function escapeInline(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`")
}

/** Keeps message text readable while preventing injected Markdown controls. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/^(\s{0,3})(#{1,6})(\s)/gm, "$1\\$2$3")
}

/** ASCII slug for the download filename; never contains path separators. */
export function slugify(title: string, fallback = "chat"): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "")
  return slug || fallback
}

/** Filename of the Markdown export; the slug is the resolved chat title. */
export function exportFilename(title: string): string {
  return `${slugify(title)}.md`
}

function messageBody(message: Message, t: Translator): string {
  const blocks: string[] = []
  const items: string[] = []
  for (const part of message.parts) {
    if (part.type === "text") {
      const text = escapeText(part.text).trim()
      if (text.length > 0) blocks.push(text)
      continue
    }
    if (part.type === "tool") {
      items.push(
        `- ${t("export.toolLine", {
          name: escapeInline(part.name),
          status: t(TOOL_STATUS[part.status]),
        })}`,
      )
      continue
    }
    if (part.type === "artifact") {
      // Only the name travels into the file: a signed download URL is short
      // lived and belongs to the chat, not to a downloaded transcript.
      items.push(
        `- ${t("export.artifactLine", {
          name: escapeInline(part.title),
          note: t("export.artifactNote"),
        })}`,
      )
    }
    // Reasoning and error parts stay in the app; they are not the answer.
  }
  if (items.length > 0) blocks.push(items.join("\n"))
  return blocks.join("\n\n")
}

/**
 * Builds the whole Markdown document from the already-loaded transcript. There
 * is no server round-trip and no upstream text: text parts are the rendered
 * answer, tools contribute a name and status, artifacts a name and a note.
 */
export function buildChatMarkdown(input: ExportInput, t: Translator): string {
  const title = input.title.replace(/\s+/g, " ").trim() || t("session.untitled")
  const sections: string[] = []
  for (const message of input.messages) {
    const body = messageBody(message, t)
    if (body.length === 0) continue
    sections.push(`## ${t(ROLE_HEADING[message.role])}\n\n${body}`)
  }
  return [`# ${escapeText(title)}`, t("export.exportedOn", { date: input.date }), ...sections]
    .join("\n\n")
    .concat("\n")
}
