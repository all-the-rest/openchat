import type { ChatFileInfo, ChatFilesResponse } from "@openchat/contracts"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ChatFiles } from "../src/chat/ChatFiles"
import { I18nProvider } from "../src/i18n/provider"

const mocks = vi.hoisted(() => ({
  chatFiles: vi.fn(),
  chatFileDownload: vi.fn(),
  deleteChatFile: vi.fn(),
  saveBlob: vi.fn(),
}))

vi.mock("../src/api/client", () => ({ api: mocks }))

vi.mock("../src/artifacts/files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/artifacts/files")>()
  return { ...actual, saveBlob: mocks.saveBlob }
})

function file(overrides: Partial<ChatFileInfo> = {}): ChatFileInfo {
  return {
    name: "report.pdf",
    displayName: "report.pdf",
    size: 2048,
    mtime: "2026-11-18T12:00:00.000Z",
    mime: "application/pdf",
    origin: "agent",
    sha256: "a".repeat(64),
    ...overrides,
  }
}

function response(overrides: Partial<ChatFilesResponse> = {}): ChatFilesResponse {
  return {
    files: [file()],
    quota: { usedBytes: 2048, quotaBytes: 1_048_576, totalUsedBytes: 4096, totalQuotaBytes: 1_073_741_824 },
    ...overrides,
  }
}

function renderPanel(children: ReactNode = <ChatFiles sessionID="ses_1" />) {
  return render(<I18nProvider initialLocale="en">{children}</I18nProvider>)
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.chatFiles.mockResolvedValue(response())
  mocks.chatFileDownload.mockResolvedValue(new Blob(["pdf"]))
  mocks.deleteChatFile.mockResolvedValue(undefined)
})

describe("chat files panel", () => {
  it("lists name, size, origin and the quota fill level", async () => {
    mocks.chatFiles.mockResolvedValue(
      response({
        files: [
          file(),
          file({ name: "template.docx", displayName: "template.docx", origin: "upload", size: 4096 }),
        ],
      }),
    )
    renderPanel()

    const items = await screen.findAllByTestId("chat-file-item")
    expect(items).toHaveLength(2)
    expect(within(items[0] as HTMLElement).getByTestId("chat-file-name")).toHaveTextContent(
      "report.pdf",
    )
    expect(within(items[0] as HTMLElement).getByTestId("chat-file-meta")).toHaveTextContent(
      "Agent",
    )
    expect(within(items[1] as HTMLElement).getByTestId("chat-file-meta")).toHaveTextContent(
      "Uploaded",
    )
    expect(screen.getByTestId("files-quota")).toHaveTextContent(/of/)
    expect(screen.getByTestId("files-quota-bar")).toHaveAttribute("value", "2048")
    expect(mocks.chatFiles).toHaveBeenCalledWith("ses_1")
  })

  it("shows an empty state and a load error with retry", async () => {
    mocks.chatFiles.mockResolvedValue(response({ files: [] }))
    const view = renderPanel()
    expect(await screen.findByTestId("files-empty")).toBeInTheDocument()
    view.unmount()

    mocks.chatFiles.mockRejectedValueOnce(new Error("down"))
    renderPanel()
    expect(await screen.findByRole("alert")).toHaveTextContent("Files could not be loaded.")
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(mocks.chatFiles).toHaveBeenCalledTimes(3))
  })

  it("downloads the exact stored bytes under the display name", async () => {
    renderPanel()
    await userEvent.click(await screen.findByRole("button", { name: "Download report.pdf" }))
    await waitFor(() =>
      expect(mocks.chatFileDownload).toHaveBeenCalledWith("ses_1", "report.pdf"),
    )
    await waitFor(() => expect(mocks.saveBlob).toHaveBeenCalledTimes(1))
    const [blob, name] = mocks.saveBlob.mock.calls[0] as [Blob, string]
    expect(blob).toBeInstanceOf(Blob)
    expect(name).toBe("report.pdf")
  })

  it("asks for confirmation and only deletes after it", async () => {
    renderPanel()
    await userEvent.click(await screen.findByRole("button", { name: "Delete report.pdf" }))
    const dialog = screen.getByRole("alertdialog", { name: "Delete this file?" })
    expect(dialog).toHaveTextContent("report.pdf")
    expect(mocks.deleteChatFile).not.toHaveBeenCalled()

    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    expect(mocks.deleteChatFile).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole("button", { name: "Delete report.pdf" }))
    const confirm = screen.getByRole("alertdialog", { name: "Delete this file?" })
    await userEvent.click(within(confirm).getByRole("button", { name: "Delete" }))
    await waitFor(() => expect(mocks.deleteChatFile).toHaveBeenCalledWith("ses_1", "report.pdf"))
    await waitFor(() => expect(screen.queryByTestId("chat-file-item")).not.toBeInTheDocument())
    expect(screen.getByTestId("files-quota")).toHaveTextContent(/0\s?B/)
  })

  it("keeps the file and reports a failed delete", async () => {
    mocks.deleteChatFile.mockRejectedValueOnce(new Error("conflict"))
    renderPanel()
    await userEvent.click(await screen.findByRole("button", { name: "Delete report.pdf" }))
    await userEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }),
    )
    expect(await screen.findByTestId("files-action-error")).toHaveTextContent(
      "The file could not be deleted.",
    )
    expect(screen.getByTestId("chat-file-item")).toBeInTheDocument()
  })
})
