import type { InboxEntry, Message, MessageStatus } from "@openchat/contracts"
import { EVENT, messageText } from "@openchat/contracts"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventStreamProvider } from "../src/api/events"
import { useChatSession } from "../src/chat/useChatSession"
import { SessionsProvider } from "../src/chat/sessions"
import { I18nProvider } from "../src/i18n/provider"
import { ChatPage } from "../src/pages/ChatPage"
import { ThemeProvider } from "../src/theme/provider"

const mocks = vi.hoisted(() => ({
  listMessages: vi.fn(),
  listInbox: vi.fn(),
  chatFiles: vi.fn(),
  cancelQueued: vi.fn(),
  listSessions: vi.fn(),
  createSession: vi.fn(),
  prompt: vi.fn(),
  interrupt: vi.fn(),
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

  emit(type: string, payload?: unknown): void {
    const event = {
      type,
      data: payload === undefined ? undefined : JSON.stringify(payload),
    } as MessageEvent
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

function assistant(status: MessageStatus, text: string, id = "msg_a"): Message {
  return {
    id,
    sessionID: "ses_1",
    role: "assistant",
    parts: [{ type: "text", id: `part_${id}`, text }],
    created: 1,
    status,
  }
}

function user(text: string, id = "msg_u"): Message {
  return {
    id,
    sessionID: "ses_1",
    role: "user",
    parts: [{ type: "text", id: `part_${id}`, text }],
    created: 1,
    status: "complete",
  }
}

function envelope(type: string, data: Record<string, unknown>): Record<string, unknown> {
  return { id: `evt_${type}`, created: 2, type, data }
}

function inboxEntry(text: string, id = "msg_queued"): InboxEntry {
  return {
    id,
    sessionID: "ses_1",
    kind: "user",
    text,
    delivery: "queue",
    created: 2,
  }
}

function SessionProbe() {
  const chat = useChatSession("ses_1")
  return (
    <div>
      {chat.messages.map((message) => (
        <p key={message.id}>{messageText(message)}</p>
      ))}
    </div>
  )
}

function renderProbe() {
  return render(
    <EventStreamProvider>
      <SessionProbe />
    </EventStreamProvider>,
  )
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
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("useChatSession reconnect", () => {
  it("reloads the active session exactly once after an SSE reconnect", async () => {
    mocks.listMessages
      .mockResolvedValueOnce([assistant("complete", "first answer")])
      .mockResolvedValueOnce([
        assistant("complete", "first answer"),
        assistant("complete", "snapshot answer", "msg_b"),
      ])

    renderProbe()
    await screen.findByText("first answer")
    expect(mocks.listMessages).toHaveBeenCalledTimes(1)

    // The first open is the initial connection and must not trigger a reload.
    act(() => source().emit("open"))
    expect(mocks.listMessages).toHaveBeenCalledTimes(1)

    // A later open means the stream reconnected; missed events are resynced.
    act(() => source().emit("open"))

    await screen.findByText("snapshot answer")
    expect(mocks.listMessages).toHaveBeenCalledTimes(2)
  })
})

describe("queued prompts", () => {
  it("queues a prompt while a run is streaming and clears it on execution.started", async () => {
    const userEventSetup = userEvent.setup()
    mocks.listMessages.mockResolvedValue([assistant("streaming", "still answering")])

    renderChat()
    await screen.findByText("still answering")

    const composer = screen.getByTestId("composer")
    await userEventSetup.type(composer, "second question{Enter}")

    await waitFor(() =>
      expect(mocks.prompt).toHaveBeenCalledWith("ses_1", {
        text: "second question",
        delivery: "queue",
      }),
    )

    expect(screen.queryByText("Your message could not be sent.")).toBeNull()
    expect(screen.getByText("Queued")).toBeInTheDocument()
    expect(
      screen.getByText("Your message is queued until the current run finishes."),
    ).toBeInTheDocument()
    // The optimistic user message stays visible and the composer stays usable.
    expect(screen.getByText("second question")).toBeInTheDocument()
    expect(composer).toBeEnabled()

    act(() =>
      source().emit(
        EVENT.executionStarted,
        envelope(EVENT.executionStarted, { sessionID: "ses_1", messageID: "msg_b" }),
      ),
    )

    await waitFor(() => expect(screen.queryByText("Queued")).toBeNull())
    expect(screen.queryByText(/queued until the current run/)).toBeNull()
    expect(screen.getByText("Assistant is responding…")).toBeInTheDocument()
  })
})

describe("inbox", () => {
  it("restores a queued turn after load and cancels it through the API", async () => {
    const userEventSetup = userEvent.setup()
    mocks.listMessages.mockResolvedValue([assistant("streaming", "still answering")])
    mocks.listInbox.mockResolvedValue([inboxEntry("waiting turn")])

    renderChat()
    expect(await screen.findByText("waiting turn")).toBeInTheDocument()
    expect(screen.getAllByText("Queued").length).toBeGreaterThan(0)

    await userEventSetup.click(screen.getByRole("button", { name: "Cancel" }))

    await waitFor(() =>
      expect(mocks.cancelQueued).toHaveBeenCalledWith("ses_1", "msg_queued"),
    )
    await waitFor(() => expect(screen.queryByText("waiting turn")).toBeNull())
    expect(screen.queryByText(/queued until the current run/)).toBeNull()
  })

  it("keeps the queued marker when the cancel request fails", async () => {
    const userEventSetup = userEvent.setup()
    mocks.listMessages.mockResolvedValue([assistant("streaming", "still answering")])
    mocks.listInbox.mockResolvedValue([inboxEntry("waiting turn")])
    mocks.cancelQueued.mockRejectedValue(new Error("conflict"))

    renderChat()
    await screen.findByText("waiting turn")
    await userEventSetup.click(screen.getByRole("button", { name: "Cancel" }))

    expect(
      await screen.findByText("The queued message could not be cancelled."),
    ).toBeInTheDocument()
    expect(screen.getByText("waiting turn")).toBeInTheDocument()
  })

  it("applies live inbox events to the queued list", async () => {
    mocks.listMessages.mockResolvedValue([assistant("streaming", "still answering")])

    renderChat()
    await screen.findByText("still answering")

    act(() =>
      source().emit(
        EVENT.inboxEnqueued,
        envelope(EVENT.inboxEnqueued, {
          sessionID: "ses_1",
          messageID: "msg_live_q",
          kind: "user",
          text: "event turn",
          delivery: "queue",
          created: 3,
        }),
      ),
    )
    expect(await screen.findByText("event turn")).toBeInTheDocument()

    act(() =>
      source().emit(
        EVENT.inboxCancelled,
        envelope(EVENT.inboxCancelled, { sessionID: "ses_1", messageID: "msg_live_q" }),
      ),
    )
    await waitFor(() => expect(screen.queryByText("event turn")).toBeNull())
  })
})

describe("continue and retry", () => {
  it("sends the continue prompt from the last assistant message", async () => {
    const userEventSetup = userEvent.setup()
    mocks.listMessages.mockResolvedValue([
      user("original question"),
      assistant("stopped", "half an answer"),
    ])

    renderChat()
    await userEventSetup.click(await screen.findByRole("button", { name: "Continue" }))

    await waitFor(() =>
      expect(mocks.prompt).toHaveBeenCalledWith("ses_1", { text: "continue" }),
    )
  })

  it("re-sends the last user message on retry", async () => {
    const userEventSetup = userEvent.setup()
    mocks.listMessages.mockResolvedValue([
      user("original question"),
      assistant("stopped", "half an answer"),
    ])

    renderChat()
    await userEventSetup.click(await screen.findByRole("button", { name: "Retry" }))

    await waitFor(() =>
      expect(mocks.prompt).toHaveBeenCalledWith("ses_1", { text: "original question" }),
    )
  })
})
