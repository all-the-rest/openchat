import type { SessionInfo } from "@openchat/contracts"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventStreamProvider } from "../src/api/events"
import { SessionSidebar } from "../src/chat/SessionSidebar"
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
  renameSession: vi.fn(),
  deleteSession: vi.fn(),
  prompt: vi.fn(),
  interrupt: vi.fn(),
  listPermissions: vi.fn(async () => []),
  replyPermission: vi.fn(async () => undefined),
  listForms: vi.fn(async () => []),
  replyForm: vi.fn(async () => undefined),
  models: vi.fn(async () => []),
  agents: vi.fn(async () => []),
  info: vi.fn(async () => ({
    dictation: { enabled: false, maxSeconds: 60, maxBytes: 1024 },
  })),
}))

vi.mock("../src/api/client", () => ({ api: mocks }))

vi.mock("../src/auth/provider", () => ({
  useAuth: () => ({
    status: "authenticated",
    user: "tester",
    signIn: vi.fn(),
    signOut: vi.fn(),
    retry: vi.fn(),
  }),
}))

type Listener = (event: MessageEvent) => void

class FakeEventSource {
  static instances: FakeEventSource[] = []
  private listeners = new Map<string, Set<Listener>>()

  constructor() {
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
  close(): void {}
  emit(type: string, data: Record<string, unknown>): void {
    const envelope = { id: `evt_${type}`, created: 1, type, data }
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(envelope) } as MessageEvent)
    }
  }
}

function session(title: string): SessionInfo {
  return { id: "ses_1", title, directory: "/workspace", created: 1, updated: 1 }
}

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}</output>
}

function renderApp() {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale="en">
        <MemoryRouter initialEntries={["/c/ses_1"]}>
          <SessionsProvider>
            <EventStreamProvider>
              <SessionSidebar />
              <LocationProbe />
              <Routes>
                <Route path="/" element={<p>home</p>} />
                <Route path="/c/:sessionId" element={<ChatPage />} />
              </Routes>
            </EventStreamProvider>
          </SessionsProvider>
        </MemoryRouter>
      </I18nProvider>
    </ThemeProvider>,
  )
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal("EventSource", FakeEventSource)
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.listSessions.mockResolvedValue([session("Old title")])
  mocks.listMessages.mockResolvedValue([])
  mocks.listInbox.mockResolvedValue([])
  mocks.listPermissions.mockResolvedValue([])
  mocks.listForms.mockResolvedValue([])
  mocks.chatFiles.mockResolvedValue({
    files: [],
    quota: { usedBytes: 0, quotaBytes: 1024, totalUsedBytes: 0, totalQuotaBytes: 4096 },
  })
  mocks.info.mockResolvedValue({
    dictation: { enabled: false, maxSeconds: 60, maxBytes: 1024 },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("chat rename", () => {
  it("updates the sidebar and the heading with the stored title", async () => {
    const user = userEvent.setup()
    mocks.renameSession.mockResolvedValue(session("New title"))
    renderApp()

    const sidebar = await screen.findByRole("complementary")
    expect(within(sidebar).getByText("Old title")).toBeInTheDocument()
    expect(await screen.findByRole("heading", { level: 1, name: "Old title" })).toBeInTheDocument()

    await user.click(screen.getByTestId("chat-menu"))
    await user.click(screen.getByTestId("chat-rename"))
    const input = screen.getByLabelText("Chat title")
    expect(input).toHaveValue("Old title")

    await user.clear(input)
    await user.type(input, "New title")
    await user.click(screen.getByTestId("chat-rename-save"))

    await waitFor(() =>
      expect(mocks.renameSession).toHaveBeenCalledWith("ses_1", "New title"),
    )
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1, name: "New title" })).toBeInTheDocument(),
    )
    expect(within(sidebar).getByText("New title")).toBeInTheDocument()
    expect(within(sidebar).queryByText("Old title")).toBeNull()
  })

  it("cancels the inline prompt with the old title intact", async () => {
    const user = userEvent.setup()
    renderApp()
    await screen.findByRole("heading", { level: 1, name: "Old title" })

    await user.click(screen.getByTestId("chat-menu"))
    await user.click(screen.getByTestId("chat-rename"))
    await user.type(screen.getByLabelText("Chat title"), " ignored")
    await user.click(screen.getByTestId("chat-rename-cancel"))

    expect(screen.queryByLabelText("Chat title")).toBeNull()
    expect(mocks.renameSession).not.toHaveBeenCalled()
    expect(screen.getByRole("heading", { level: 1, name: "Old title" })).toBeInTheDocument()
  })
})

describe("chat delete", () => {
  it("asks for confirmation, removes the chat and goes home", async () => {
    const user = userEvent.setup()
    mocks.deleteSession.mockResolvedValue(undefined)
    renderApp()
    const sidebar = await screen.findByRole("complementary")
    await within(sidebar).findByText("Old title")

    await user.click(screen.getByTestId("chat-menu"))
    await user.click(screen.getByTestId("chat-delete"))
    expect(screen.getByTestId("chat-delete-confirm")).toBeInTheDocument()
    expect(screen.getByText("Delete this chat? This cannot be undone.")).toBeInTheDocument()

    // Cancel leaves the chat alone and returns to the action list.
    await user.click(screen.getByTestId("chat-delete-cancel"))
    expect(screen.queryByTestId("chat-delete-confirm")).toBeNull()
    expect(mocks.deleteSession).not.toHaveBeenCalled()

    await user.click(screen.getByTestId("chat-delete"))
    await user.click(screen.getByTestId("chat-delete-confirm-button"))

    await waitFor(() => expect(mocks.deleteSession).toHaveBeenCalledWith("ses_1"))
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/))
    expect(within(sidebar).queryByText("Old title")).toBeNull()
    expect(screen.getByText("home")).toBeInTheDocument()
  })
})
