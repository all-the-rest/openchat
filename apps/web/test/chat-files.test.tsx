import type { ChatFileInfo, ChatFilesResponse } from "@openchat/contracts"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ChatFiles } from "../src/chat/ChatFiles"
import { I18nProvider } from "../src/i18n/provider"

const mocks = vi.hoisted(() => ({
  chatFiles: vi.fn(),
  deleteChatFile: vi.fn(),
  chatFileDownloadUrl: vi.fn(
    (sessionID: string, name: string) =>
      `/api/sessions/${sessionID}/files/${encodeURIComponent(name)}`,
  ),
}))

vi.mock("../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/client")>()
  return { ...actual, api: mocks }
})

const SESSION = "ses_files"

function file(overrides: Partial<ChatFileInfo> = {}): ChatFileInfo {
  return {
    name: "quarterly.docx",
    displayName: "quarterly.docx",
    size: 1536,
    mtime: "2026-11-18T12:00:00.000Z",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    origin: "upload",
    sha256: "a".repeat(64),
    ...overrides,
  }
}

function response(overrides: Partial<ChatFilesResponse> = {}): ChatFilesResponse {
  return {
    files: [file()],
    quota: { usedBytes: 1536, quotaBytes: 4096, totalUsedBytes: 1536, totalQuotaBytes: 1_000_000 },
    ...overrides,
  }
}

function renderFiles(children: ReactNode = <ChatFiles sessionID={SESSION} />) {
  return render(<I18nProvider initialLocale="en">{children}</I18nProvider>)
}

beforeEach(() => {
  mocks.chatFiles.mockReset()
  mocks.deleteChatFile.mockReset()
  mocks.chatFileDownloadUrl.mockClear()
  mocks.chatFiles.mockResolvedValue(response())
})

describe("chat file list", () => {
  it("shows name, size, origin and a download link per file", async () => {
    mocks.chatFiles.mockResolvedValue(
      response({
        files: [file(), file({ name: "report.pdf", displayName: "report.pdf", size: 2048, origin: "agent" })],
      }),
    )
    renderFiles()

    const rows = await screen.findAllByTestId("chat-file")
    expect(rows).toHaveLength(2)
    expect(within(rows[0] as HTMLElement).getByTestId("chat-file-name")).toHaveTextContent(
      "quarterly.docx",
    )
    expect(within(rows[0] as HTMLElement).getByTestId("chat-file-size")).toHaveTextContent("1.5kB")
    expect(within(rows[0] as HTMLElement).getByText("Uploaded")).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText("Agent")).toBeInTheDocument()

    const download = within(rows[1] as HTMLElement).getByRole("link", {
      name: "Download report.pdf",
    })
    expect(download).toHaveAttribute("href", `/api/sessions/${SESSION}/files/report.pdf`)
    expect(download).toHaveAttribute("download", "report.pdf")
  })

  it("renders the quota fill level next to the list", async () => {
    renderFiles()

    expect(await screen.findByTestId("files-quota-text")).toHaveTextContent(
      "1.5kB of 4kB used (38%)",
    )
    expect(screen.getByTestId("files-quota")).toHaveAttribute("value", "1536")
    expect(screen.getByTestId("files-quota")).toHaveAttribute("max", "4096")
  })

  it("renders nothing for a chat without files", async () => {
    mocks.chatFiles.mockResolvedValue(response({ files: [], quota: response().quota }))
    renderFiles()

    await waitFor(() => expect(mocks.chatFiles).toHaveBeenCalledWith(SESSION))
    expect(screen.queryByTestId("chat-files")).toBeNull()
  })

  it("asks before deleting and keeps the file on cancel", async () => {
    const user = userEvent.setup()
    renderFiles()

    await user.click(await screen.findByRole("button", { name: "Delete quarterly.docx" }))
    const dialog = screen.getByRole("alertdialog")
    expect(dialog).toHaveTextContent("Delete this file?")
    expect(dialog).toHaveTextContent("quarterly.docx will be removed from this chat.")

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    expect(screen.queryByRole("alertdialog")).toBeNull()
    expect(mocks.deleteChatFile).not.toHaveBeenCalled()
    expect(screen.getByTestId("chat-file")).toBeInTheDocument()
  })

  it("deletes after confirmation and reloads the list", async () => {
    const user = userEvent.setup()
    mocks.deleteChatFile.mockResolvedValue(undefined)
    mocks.chatFiles
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response({ files: [] }))
    renderFiles()

    await user.click(await screen.findByRole("button", { name: "Delete quarterly.docx" }))
    await user.click(screen.getByRole("button", { name: "Delete file" }))

    expect(mocks.deleteChatFile).toHaveBeenCalledWith(SESSION, "quarterly.docx")
    await waitFor(() => expect(screen.queryByTestId("chat-files")).toBeNull())
    expect(mocks.chatFiles).toHaveBeenCalledTimes(2)
  })

  it("keeps the file and reports a failed delete", async () => {
    const user = userEvent.setup()
    mocks.deleteChatFile.mockRejectedValue(new Error("offline"))
    renderFiles()

    await user.click(await screen.findByRole("button", { name: "Delete quarterly.docx" }))
    await user.click(screen.getByRole("button", { name: "Delete file" }))

    expect(await screen.findByText("The file could not be deleted.")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(screen.queryByText("The file could not be deleted.")).toBeNull()
    expect(screen.getByTestId("chat-file")).toBeInTheDocument()
  })

  it("reports a failed read and retries it", async () => {
    const user = userEvent.setup()
    mocks.chatFiles
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(response())
    renderFiles()

    expect(await screen.findByText("The file list could not be loaded.")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Retry" }))
    expect(await screen.findByTestId("chat-file")).toBeInTheDocument()
  })

  it("never shows the previous chat's files while the next chat loads", async () => {
    let release!: (value: ChatFilesResponse) => void
    const view = renderFiles()
    expect(await screen.findByTestId("chat-file")).toBeInTheDocument()

    mocks.chatFiles.mockReturnValueOnce(
      new Promise<ChatFilesResponse>((resolve) => (release = resolve)),
    )
    view.rerender(
      <I18nProvider initialLocale="en">
        <ChatFiles sessionID="ses_other" />
      </I18nProvider>,
    )
    expect(screen.queryByTestId("chat-file")).toBeNull()

    await act(async () => release(response({ files: [] })))
    expect(screen.queryByTestId("chat-files")).toBeNull()
  })

  it("refetches when the page bumps the version after an upload or send", async () => {
    mocks.chatFiles.mockResolvedValue(response({ files: [] }))
    const view = renderFiles()
    await waitFor(() => expect(mocks.chatFiles).toHaveBeenCalledTimes(1))

    view.rerender(
      <I18nProvider initialLocale="en">
        <ChatFiles sessionID={SESSION} version={1} />
      </I18nProvider>,
    )

    await waitFor(() => expect(mocks.chatFiles).toHaveBeenCalledTimes(2))
  })

  it("uses the German catalogue for labels", async () => {
    render(
      <I18nProvider initialLocale="de">
        <ChatFiles sessionID={SESSION} />
      </I18nProvider>,
    )

    const row = await screen.findByTestId("chat-file")
    expect(within(row).getByText("Hochgeladen")).toBeInTheDocument()
    expect(within(row).getByText("Herunterladen")).toBeInTheDocument()
    expect(within(row).getByText("Löschen")).toBeInTheDocument()
    expect(await screen.findByTestId("files-quota-text")).toHaveTextContent("belegt")
  })
})
