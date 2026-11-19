import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventStreamProvider } from "../src/api/events"
import { ConnectionNotice } from "../src/chat/ConnectionNotice"
import { SessionsProvider } from "../src/chat/sessions"
import { I18nProvider } from "../src/i18n/provider"
import { ChatPage } from "../src/pages/ChatPage"
import { LandingPage } from "../src/pages/LandingPage"
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

  emit(type: string): void {
    const event = { type } as MessageEvent
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

function source(): FakeEventSource {
  const instance = FakeEventSource.instances.at(-1)
  if (!instance) throw new Error("EventSource was not created")
  return instance
}

function wrap(children: ReactNode, entries: string[] = ["/c/ses_1"]) {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale="en">
        <SessionsProvider>
          <EventStreamProvider>
            <MemoryRouter initialEntries={entries}>{children}</MemoryRouter>
          </EventStreamProvider>
        </SessionsProvider>
      </I18nProvider>
    </ThemeProvider>,
  )
}

function renderChat() {
  return wrap(
    <Routes>
      <Route path="/c/:sessionId" element={<ChatPage />} />
    </Routes>,
  )
}

function renderLanding() {
  return wrap(
    <Routes>
      <Route path="/" element={<LandingPage />} />
    </Routes>,
    ["/"],
  )
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal("EventSource", FakeEventSource)
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.listMessages.mockResolvedValue([])
  mocks.listInbox.mockResolvedValue([])
  mocks.listSessions.mockResolvedValue([])
  mocks.chatFiles.mockResolvedValue({
    files: [],
    quota: { usedBytes: 0, quotaBytes: 1024, totalUsedBytes: 0, totalQuotaBytes: 4096 },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("connection recovery notice", () => {
  it("announces the outage, the recovery, and reloads the session exactly once", async () => {
    renderChat()
    await waitFor(() => expect(mocks.listMessages).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId("connection-lost")).toBeNull()

    // The first open is the initial connection, not a reconnect.
    act(() => source().emit("open"))
    act(() => source().emit("error"))

    const lost = await screen.findByTestId("connection-lost")
    expect(lost).toHaveAttribute("role", "alert")
    expect(lost).toHaveTextContent("Connection lost — reconnecting…")

    act(() => source().emit("open"))

    const back = await screen.findByTestId("connection-reconnected")
    expect(back).toHaveAttribute("role", "status")
    expect(back).toHaveTextContent("Reconnected")

    await waitFor(() => expect(mocks.listMessages).toHaveBeenCalledTimes(2))
    expect(mocks.listMessages).toHaveBeenCalledTimes(2)
  })

  it("dismisses the outage notice and shows it again on the next outage", async () => {
    const user = userEvent.setup()
    renderChat()
    await waitFor(() => expect(mocks.listMessages).toHaveBeenCalledTimes(1))

    act(() => source().emit("open"))
    act(() => source().emit("error"))
    expect(await screen.findByTestId("connection-lost")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(screen.queryByTestId("connection-lost")).toBeNull()

    act(() => source().emit("open"))
    await waitFor(() => expect(mocks.listMessages).toHaveBeenCalledTimes(2))

    act(() => source().emit("error"))
    expect(await screen.findByTestId("connection-lost")).toBeInTheDocument()
  })

  it("keeps the reconnected hint only for a short while", async () => {
    wrap(
      <>
        <ConnectionNotice reconnectedMs={30} />
        <Routes>
          <Route path="/c/:sessionId" element={<p>chat</p>} />
        </Routes>
      </>,
    )

    // The first open is the initial connection, not a reconnect.
    act(() => source().emit("open"))
    expect(screen.queryByTestId("connection-reconnected")).toBeNull()

    act(() => source().emit("open"))
    expect(await screen.findByTestId("connection-reconnected")).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByTestId("connection-reconnected")).toBeNull())
  })

  it("shows the outage notice on the landing page without an active session", async () => {
    renderLanding()

    act(() => source().emit("error"))

    const lost = await screen.findByTestId("connection-lost")
    expect(lost).toHaveTextContent("Connection lost — reconnecting…")
  })
})
