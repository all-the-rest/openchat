import { describe, expect, it } from "vitest"
import {
  attachmentFilePath,
  formatAttachmentReferences,
  withAttachmentReferences,
} from "../src/chat/attachment-ref"

const SESSION = "ses_123"

describe("attachment references", () => {
  it("builds the container path from the stored name", () => {
    expect(attachmentFilePath(SESSION, "report.pdf")).toBe(
      "/workspace/chats/ses_123/files/report.pdf",
    )
  })

  it("renders one line per stored name", () => {
    expect(formatAttachmentReferences(SESSION, ["report.pdf", "notes.txt"])).toBe(
      "Attached files:\n" +
        "- report.pdf (/workspace/chats/ses_123/files/report.pdf)\n" +
        "- notes.txt (/workspace/chats/ses_123/files/notes.txt)",
    )
  })

  it("returns nothing when no file was attached", () => {
    expect(formatAttachmentReferences(SESSION, [])).toBe("")
  })

  it("appends the block after the typed prompt", () => {
    expect(withAttachmentReferences("Summarize this", SESSION, ["report.pdf"])).toBe(
      "Summarize this\n\n" +
        "Attached files:\n" +
        "- report.pdf (/workspace/chats/ses_123/files/report.pdf)",
    )
  })

  it("leaves the prompt alone when there is no block", () => {
    expect(withAttachmentReferences("Hello", SESSION, [])).toBe("Hello")
  })

  it("uses the stored name, never a client path", () => {
    const block = formatAttachmentReferences(SESSION, ["scan-1.png"])
    expect(block).not.toContain("Users")
    expect(block).not.toContain("private/var")
    expect(block).toContain("/workspace/chats/ses_123/files/scan-1.png")
  })
})
