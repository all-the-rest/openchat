import { describe, expect, it } from "vitest"
import type { Message } from "@openchat/contracts"
import {
  buildChatMarkdown,
  chatFilename,
  escapeMarkdown,
  isoDate,
  slugifyTitle,
  type ExportLabels,
} from "../src/chat/export"

const labels: ExportLabels = {
  date: "Date",
  user: "You said",
  assistant: "Assistant answer",
  system: "System note",
  tool: "Tool",
  artifact: "Artifact",
  artifactNote: "Its files are stored in this chat.",
  untitled: "Untitled",
}

const TOOL_STATUS = {
  queued: "Queued",
  running: "Running",
  success: "Done",
  error: "Error",
} as const

const transcript: Message[] = [
  {
    id: "msg_user",
    sessionID: "ses_1",
    role: "user",
    created: 1_700_000_000_000,
    status: "complete",
    parts: [{ type: "text", id: "part_user", text: "# Not a heading\n- not a list" }],
  },
  {
    id: "msg_assistant",
    sessionID: "ses_1",
    role: "assistant",
    created: 1_700_000_001_000,
    status: "complete",
    parts: [
      { type: "text", id: "part_text", text: "Answer with `code`." },
      { type: "reasoning", id: "part_reason", text: "PRIVATE REASONING" },
      {
        type: "tool",
        id: "part_tool",
        callID: "call_1",
        name: "read",
        status: "success",
        input: "SECRET INPUT",
        output: "SECRET TOOL BODY",
      },
      {
        type: "artifact",
        id: "part_artifact",
        artifactID: "art_1",
        title: "Report",
        mime: "text/html",
      },
    ],
  },
  {
    id: "msg_system",
    sessionID: "ses_1",
    role: "system",
    created: 1_700_000_002_000,
    status: "complete",
    parts: [{ type: "text", id: "part_system", text: "A tool request was denied" }],
  },
]

describe("chat markdown export", () => {
  it("builds the exact document from loaded parts", () => {
    const markdown = buildChatMarkdown({
      title: "Quarterly Review",
      created: 1_700_000_000_000,
      messages: transcript,
      labels,
      toolStatus: (status) => TOOL_STATUS[status],
    })

    expect(markdown).toBe(
      [
        "# Quarterly Review",
        "",
        "Date: 2023-11-14",
        "",
        "## You said",
        "",
        "\\# Not a heading",
        "\\- not a list",
        "",
        "## Assistant answer",
        "",
        "Answer with `code`.",
        "",
        "- Tool: read (Done)",
        "- Artifact: Report — Its files are stored in this chat.",
        "",
        "## System note",
        "",
        "A tool request was denied",
        "",
      ].join("\n"),
    )

    // Tool bodies, inputs and reasoning never leave the chat in an export.
    expect(markdown).not.toContain("SECRET")
    expect(markdown).not.toContain("PRIVATE REASONING")
  })

  it("omits a date it cannot parse and falls back to the untitled label", () => {
    const markdown = buildChatMarkdown({
      title: "   ",
      created: Number.NaN,
      messages: [],
      labels,
      toolStatus: (status) => TOOL_STATUS[status],
    })
    expect(markdown).toBe("# Untitled\n")
    expect(isoDate(Number.NaN)).toBeNull()
  })

  it("escapes block markers without touching inline emphasis", () => {
    expect(escapeMarkdown("> quote\n1. first\n+ plus")).toBe(
      "\\> quote\n1\\. first\n\\+ plus",
    )
    expect(escapeMarkdown("**bold** and _italic_")).toBe("**bold** and _italic_")
    expect(escapeMarkdown("```ts")).toBe("\\`\\`\\`ts")
  })

  it("slugifies the title for a safe filename", () => {
    expect(slugifyTitle("Quarterly Review")).toBe("quarterly-review")
    expect(slugifyTitle("Über Größe & Café")).toBe("ueber-groesse-cafe")
    expect(slugifyTitle("  Waves  /  files  ")).toBe("waves-files")
    expect(chatFilename("Quarterly Review")).toBe("quarterly-review.md")
    expect(chatFilename("***")).toBe("chat.md")
  })

  it("caps the slug length and never ends it with a dash", () => {
    const slug = slugifyTitle(`${"a".repeat(55)} ${"b".repeat(20)}`)
    expect(slug.length).toBeLessThanOrEqual(60)
    expect(slug.endsWith("-")).toBe(false)
  })
})
