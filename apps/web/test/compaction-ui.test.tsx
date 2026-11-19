import { EVENT, type Message } from "@openchat/contracts"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventStreamProvider } from "../src/api/events"
import { SessionsProvider } from "../src/chat/sessions"
import { I18nProvider } from "../src/i18n/provider"
import { ChatPage } from "../src/pages/ChatPage"
import { ThemeProvider } from "../src/theme/provider"

const mocks = vi.hoisted(() => ({
  listMessages: vi.fn(),
  listInbox: vi.fn(),
  cancelQueued: vi.fn(),
  listSessions: vi.fn(),
  chatFiles: vi.fn(),
  deleteChatFile: vi.fn(),
  chatFileDownloadUrl: vi.fn(),
  createSession: vi.fn(),
  prompt: vi.fn(),
  interrupt: vi.fn(),
  compact: vi.fn(),
  listPermissions: vi.fn(async () => []),
  replyPermission: vi.fn(async () => undefined),
  listForms: vi.fn(async () => []),
  replyForm: vi.fn(async () => undefined),
  models: vi.fn(async () => []),
  agents: vi.fn(async () => []),
  me: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  info: vi.fn(),
}))

vi.mock("../src/api/client", () => ({
  api: mocks,
  ApiError: class ApiError extends Error {
    readonly status: number
    readonly code: string | undefined

    constructor(status: number, message: string, code?: string) {
      super(message)
      this.status = status
      this.code = code
    }

    get isUnauthorized(): boolean {
      return this.status === 401
    }
  },
}))

type Listener = (event: MessageEvent) => void

class FakeEventSource {
  static instances: FakeEventSource[] = []

  readonly url: string
  closed = false
  private listeners = new Map<string, Set<Listener>>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  close(): void {
    this.closed = true
  }

  emit(type: string, payload: unknown): void {
    const event = { type, data: JSON.stringify(payload) } as MessageEvent
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

function assistant(status: Message["status"], text: string): Message {
  return {
    id: "msg_a",
    sessionID: "ses_1",
    role: "assistant",
    parts: [{ type: "text", id: "part_a", text }],
    created: 1,
    status,
  }
}

function envelope(type: string, data: Record<string, unknown>): Record<string, unknown> {
  return { id: `evt_${type}`, created: 2, type, data }
}

function renderChat() {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale="en">
        <SessionsProvider>
          <EventStreamProvider>
            <MemoryRouter initialEntries={["/c/ses_1"]}>
              <Routes>
                <Route path="/c/:sessionId" element={<ChatPage />} />
              </Routes>
            </MemoryRouter>
          </EventStreamProvider>
        </SessionsProvider>
      </I18nProvider>
    </ThemeProvider>,
  )
}

function source(): FakeEventSource {
  const instance = FakeEventSource.instances.at(-1)
  if (!instance) throw new Error("EventSource was not created")
  return instance
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal("EventSource", FakeEventSource)
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.listSessions.mockResolvedValue([])
  mocks.listInbox.mockResolvedValue([])
  mocks.chatFiles.mockResolvedValue({
    files: [],
    quota: { usedBytes: 0, quotaBytes: 1024, totalUsedBytes: 0, totalQuotaBytes: 4096 },
  })
  mocks.cancelQueued.mockResolvedValue(undefined)
  mocks.prompt.mockResolvedValue({ ok: true, messageID: "msg_b" })
  mocks.interrupt.mockResolvedValue(undefined)
  mocks.compact.mockResolvedValue({ ok: true, status: "accepted" })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("compaction notices", () => {
  it("renders started and ended as one collapsed section with the summary", async () => {
    mocks.listMessages.mockResolvedValue([])
    renderChat()
    await screen.findByTestId("transcript")

    act(() => {
      source().emit(
        EVENT.compactionStarted,
        envelope(EVENT.compactionStarted, { sessionID: "ses_1", reason: "auto" }),
      )
    })
    expect(await screen.findByTestId("compaction-started")).toBeInTheDocument()
    expect(screen.queryByTestId("compaction-ended")).toBeNull()

    act(() => {
      source().emit(
        EVENT.compactionEnded,
        envelope(EVENT.compactionEnded, {
          sessionID: "ses_1",
          reason: "auto",
          text: "Earlier turns summarised.",
        }),
      )
    })

    const ended = await screen.findByTestId("compaction-ended")
    expect(ended).toHaveTextContent("Compaction finished")
    expect(ended).toHaveTextContent("Automatic")
    expect(screen.getByTestId("compaction-summary")).toHaveTextContent(
      "Earlier turns summarised.",
    )
    expect(ended).not.toHaveAttribute("open")
  })

  it("renders a failure reason and retries through the BFF", async () => {
    const user = userEvent.setup()
    mocks.listMessages.mockResolvedValue([])
    renderChat()
    await screen.findByTestId("transcript")

    act(() => {
      source().emit(
        EVENT.compactionStarted,
        envelope(EVENT.compactionStarted, { sessionID: "ses_1", reason: "manual" }),
      )
      source().emit(
        EVENT.compactionFailed,
        envelope(EVENT.compactionFailed, {
          sessionID: "ses_1",
          reason: "manual",
          error: { type: "fake_error", message: "The summariser failed." },
        }),
      )
    })

    const failed = await screen.findByTestId("compaction-failed")
    expect(failed).toHaveTextContent("Compaction failed")
    expect(screen.getByTestId("compaction-reason")).toHaveTextContent(
      "The summariser failed.",
    )

    await user.click(screen.getByTestId("compaction-retry"))
    await waitFor(() => expect(mocks.compact).toHaveBeenCalledWith("ses_1"))
    await waitFor(() => expect(screen.queryByTestId("compaction-failed")).toBeNull())
  })

  it("surfaces a prompt notice as a system line", async () => {
    const user = userEvent.setup()
    mocks.listMessages.mockResolvedValue([])
    mocks.prompt.mockResolvedValue({
      ok: true,
      messageID: "msg_b",
      notices: ["contextCompacted"],
    })
    renderChat()
    await screen.findByTestId("composer")

    await user.type(screen.getByTestId("composer"), "hello{Enter}")
    expect(
      await screen.findByText("Context was compacted before sending your message."),
    ).toBeInTheDocument()
  })
})

describe("compact now", () => {
  it("is disabled while the assistant is streaming", async () => {
    const user = userEvent.setup()
    mocks.listMessages.mockResolvedValue([assistant("streaming", "still answering")])
    renderChat()
    await screen.findByText("still answering")

    await user.click(screen.getByTestId("chat-menu"))
    expect(screen.getByTestId("compact-now")).toBeDisabled()
  })

  it("calls the compaction route when idle", async () => {
    const user = userEvent.setup()
    mocks.listMessages.mockResolvedValue([assistant("complete", "done")])
    renderChat()
    await screen.findByText("done")

    await user.click(screen.getByTestId("chat-menu"))
    await user.click(screen.getByTestId("compact-now"))
    await waitFor(() => expect(mocks.compact).toHaveBeenCalledWith("ses_1"))
  })
})
