import type { ChatFileInfo } from "@openchat/contracts"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "../src/api/client"
import { Composer } from "../src/chat/Composer"
import { I18nProvider } from "../src/i18n/provider"

const mocks = vi.hoisted(() => ({ uploadChatFile: vi.fn() }))

vi.mock("../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/client")>()
  return { ...actual, api: { ...actual.api, uploadChatFile: mocks.uploadChatFile } }
})

const SESSION = "ses_upload"
const stored: ChatFileInfo = {
  name: "report.pdf",
  displayName: "report.pdf",
  size: 11,
  mtime: "2026-11-18T12:00:00.000Z",
  mime: "application/pdf",
  origin: "upload",
  sha256: "a".repeat(64),
}

function pdfFile(name = "report.pdf"): File {
  return new File(["%PDF-1.7\n"], name, { type: "application/pdf" })
}

function renderComposer(onSend = vi.fn(async (_text: string) => undefined), onUploaded = vi.fn()) {
  render(
    <I18nProvider initialLocale="en">
      <Composer
        onSend={onSend}
        onStop={vi.fn()}
        running={false}
        sessionID={SESSION}
        dictation={null}
        onAttachmentsChanged={onUploaded}
      />
    </I18nProvider>,
  )
  return { onSend, onUploaded }
}

function pick(file: File) {
  fireEvent.change(screen.getByTestId("attachment-input"), { target: { files: [file] } })
}

beforeEach(() => {
  mocks.uploadChatFile.mockReset()
  mocks.uploadChatFile.mockResolvedValue(stored)
})

describe("composer attachments", () => {
  it("uploads a picked file immediately and shows a ready chip", async () => {
    renderComposer()
    pick(pdfFile())

    await waitFor(() => expect(screen.getByTestId("attachment-chip")).toHaveAttribute("data-status", "ready"))
    expect(mocks.uploadChatFile).toHaveBeenCalledWith(SESSION, "report.pdf", expect.any(File))
    expect(screen.getByTestId("attachment-name")).toHaveTextContent("report.pdf")
  })

  it("appends the reference block to the prompt text on send", async () => {
    const { onSend } = renderComposer()
    pick(pdfFile())
    await waitFor(() => expect(screen.getByTestId("attachment-chip")).toHaveAttribute("data-status", "ready"))
    const user = userEvent.setup()
    await user.type(screen.getByTestId("composer"), "Summarize this")

    await user.click(screen.getByTestId("send"))

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(
        "Summarize this\n\nAttached files:\n- report.pdf (/workspace/chats/ses_upload/files/report.pdf)",
      ),
    )
    expect(screen.queryByTestId("attachment-chip")).toBeNull()
  })

  it("disables send while an upload runs and re-enables it when the chip is ready", async () => {
    let release!: (file: ChatFileInfo) => void
    mocks.uploadChatFile.mockReturnValue(new Promise<ChatFileInfo>((resolve) => (release = resolve)))
    renderComposer()
    const user = userEvent.setup()
    await user.type(screen.getByTestId("composer"), "hello")
    expect(screen.getByTestId("send")).toBeEnabled()

    pick(pdfFile())
    expect(screen.getByTestId("attachment-chip")).toHaveAttribute("data-status", "uploading")
    expect(screen.getByTestId("send")).toBeDisabled()

    release(stored)
    await waitFor(() => expect(screen.getByTestId("send")).toBeEnabled())
  })

  it("keeps a rejected chip with an i18n error and lets the owner remove it", async () => {
    mocks.uploadChatFile.mockRejectedValue(
      new ApiError(415, "refused", "unsupported_media_type"),
    )
    renderComposer()
    pick(pdfFile())

    expect(await screen.findByTestId("attachment-error")).toHaveTextContent(
      "This file type is not allowed.",
    )
    expect(screen.getByTestId("attachment-chip")).toHaveAttribute("data-status", "error")

    await userEvent.setup().click(screen.getByTestId("attachment-remove"))
    expect(screen.queryByTestId("attachment-chip")).toBeNull()
  })

  it("accepts a file dropped on the composer", async () => {
    renderComposer()
    fireEvent.drop(screen.getByTestId("composer-dropzone"), {
      dataTransfer: { files: [pdfFile()] },
    })

    await waitFor(() =>
      expect(mocks.uploadChatFile).toHaveBeenCalledWith(SESSION, "report.pdf", expect.any(File)),
    )
  })

  it("accepts a file pasted from the clipboard", async () => {
    renderComposer()
    const file = pdfFile()
    fireEvent.paste(screen.getByTestId("composer"), {
      clipboardData: {
        items: [{ kind: "file", getAsFile: () => file }],
      },
    })

    await waitFor(() =>
      expect(mocks.uploadChatFile).toHaveBeenCalledWith(SESSION, "report.pdf", expect.any(File)),
    )
  })

  it("refreshes the file list after a successful upload", async () => {
    const { onUploaded } = renderComposer()
    pick(pdfFile())

    await waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(1))
  })

  it("uses the German catalogue for chip errors", async () => {
    mocks.uploadChatFile.mockRejectedValue(new ApiError(415, "refused", "payload_too_large"))
    render(
      <I18nProvider initialLocale="de">
        <Composer onSend={vi.fn()} onStop={vi.fn()} running={false} sessionID={SESSION} dictation={null} />
      </I18nProvider>,
    )
    pick(pdfFile())

    expect(await screen.findByTestId("attachment-error")).toHaveTextContent(
      "Diese Datei ist zu groß.",
    )
  })
})
