import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventStreamProvider } from "../src/api/events"
import { ChatPage } from "../src/pages/ChatPage"
import { Composer } from "../src/chat/Composer"
import { SessionsProvider } from "../src/chat/sessions"
import { I18nProvider } from "../src/i18n/provider"
import { ThemeProvider } from "../src/theme/provider"

/** Minimal API surface the chat page and the composer read on mount. */
const mocks = vi.hoisted(() => ({
  listMessages: vi.fn(async () => []),
  listInbox: vi.fn(async () => []),
  cancelQueued: vi.fn(async () => undefined),
  listSessions: vi.fn(async () => []),
  chatFiles: vi.fn(async () => ({
    files: [],
    quota: { usedBytes: 0, quotaBytes: 1024, totalUsedBytes: 0, totalQuotaBytes: 4096 },
  })),
  deleteChatFile: vi.fn(async () => undefined),
  chatFileDownloadUrl: vi.fn(async () => ""),
  createSession: vi.fn(async () => ({ id: "ses_1" })),
  prompt: vi.fn(async () => ({ ok: true, messageID: "msg_b" })),
  interrupt: vi.fn(async () => undefined),
  listPermissions: vi.fn(async () => []),
  replyPermission: vi.fn(async () => undefined),
  listForms: vi.fn(async () => []),
  replyForm: vi.fn(async () => undefined),
  models: vi.fn(async () => []),
  agents: vi.fn(async () => []),
  info: vi.fn(async () => ({})),
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

  addEventListener(_type: string, _listener: Listener): void {}
  removeEventListener(_type: string, _listener: Listener): void {}
  close(): void {}
}

/** Media-query stub in the composer.test.tsx convention. */
function stubMatchMedia(queries: Record<string, boolean>) {
  return vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: queries[query] ?? false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as MediaQueryList,
  )
}

function renderComposer(
  onSend = vi.fn(async (_text: string) => undefined),
  onStop = vi.fn(),
  running = false,
) {
  render(
    <I18nProvider initialLocale="en">
      <Composer onSend={onSend} onStop={onStop} running={running} />
    </I18nProvider>,
  )
  return { onSend, onStop }
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

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal("EventSource", FakeEventSource)
  for (const mock of Object.values(mocks)) mock.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("mobile composer layout", () => {
  it("puts actions on their own row with 44px targets for a coarse pointer", () => {
    const matchMedia = stubMatchMedia({ "(pointer: coarse)": true })
    try {
      renderComposer()

      const actions = screen.getByTestId("composer-actions")
      // w-full below `sm` makes the row wrap under the textarea; sm:w-auto
      // restores the single desktop row.
      expect(actions).toHaveClass("w-full", "sm:w-auto", "min-h-11")
      expect(screen.getByTestId("send")).toHaveClass("min-h-11", "min-w-11")
    } finally {
      matchMedia.mockRestore()
    }
  })

  it("keeps a single row without enlarged targets on a fine pointer", () => {
    const matchMedia = stubMatchMedia({ "(pointer: coarse)": false })
    try {
      renderComposer()

      const actions = screen.getByTestId("composer-actions")
      expect(actions).toHaveClass("sm:w-auto")
      expect(screen.getByTestId("send")).not.toHaveClass("min-h-11")
    } finally {
      matchMedia.mockRestore()
    }
  })

  it("keeps send and stop clickable with a coarse pointer", async () => {
    const user = userEvent.setup()
    const matchMedia = stubMatchMedia({ "(pointer: coarse)": true })
    try {
      const onSend = vi.fn(async (_text: string) => undefined)
      const onStop = vi.fn()
      renderComposer(onSend, onStop, true)

      await user.type(screen.getByTestId("composer"), "hello")
      await user.click(screen.getByTestId("send"))
      await waitFor(() => expect(onSend).toHaveBeenCalledWith("hello"))
      await user.click(screen.getByTestId("stop"))
      expect(onStop).toHaveBeenCalledTimes(1)
    } finally {
      matchMedia.mockRestore()
    }
  })
})

describe("narrow chat header", () => {
  it("keeps the title visible and the actions reachable through the overflow", async () => {
    const matchMedia = stubMatchMedia({
      "(pointer: coarse)": true,
      "(min-width: 640px)": false,
    })
    try {
      const user = userEvent.setup()
      renderChat()
      await waitFor(() => expect(mocks.listMessages).toHaveBeenCalled())

      expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument()
      // The session menu stays inline; only secondary controls overflow.
      expect(screen.getByTestId("chat-menu")).toBeInTheDocument()

      const container = screen.getByTestId("chat-header-actions")
      expect(container).toBeInTheDocument()
      const trigger = screen.getByTestId("chat-header-more")
      expect(trigger).toHaveAttribute("aria-expanded", "false")

      await user.click(trigger)
      expect(screen.getByTestId("chat-header-actions-panel")).toBeInTheDocument()
      expect(screen.getByTestId("usage-trigger")).toBeInTheDocument()
    } finally {
      matchMedia.mockRestore()
    }
  })
})
