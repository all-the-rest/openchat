import type { Message, SessionInfo } from "@openchat/contracts"
import { render, screen, waitFor } from "@testing-library/react"
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
  forkSession: vi.fn(),
  prompt: vi.fn(),
  interrupt: vi.fn(),
  compact: vi.fn(),
  listPermissions: vi.fn(async () => []),
  replyPermission: vi.fn(async () => undefined),
  models: vi.fn(async () => []),
  agents: vi.fn(async () => []),
  me: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  info: vi.fn(),
}))

vi.mock("../src/api/client", () => ({
  api: mocks,
  ApiError: class ApiError extends Error {},
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

function assistant(text: string): Message {
  return {
    id: "msg_a",
    sessionID: "ses_1",
    role: "assistant",
    parts: [{ type: "text", id: "part_a", text }],
    created: 2,
    status: "complete",
  }
}

function sessionInfo(
  id: string,
  title: string,
  branch?: { branchOf: string; branchBefore: string },
): SessionInfo {
  return { id, title, directory: "/workspace", created: 1, updated: 1, ...branch }
}

function renderChat(sessionID = "ses_1") {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale="en">
        <SessionsProvider>
          <EventStreamProvider>
            <MemoryRouter initialEntries={[`/c/${sessionID}`]}>
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
  window.sessionStorage.clear()
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.listInbox.mockResolvedValue([])
  mocks.listSessions.mockResolvedValue([sessionInfo("ses_1", "Parent chat")])
  mocks.chatFiles.mockResolvedValue({
    files: [],
    quota: { usedBytes: 0, quotaBytes: 1024, totalUsedBytes: 0, totalQuotaBytes: 4096 },
  })
  mocks.cancelQueued.mockResolvedValue(undefined)
  mocks.prompt.mockResolvedValue({ ok: true, messageID: "msg_reply" })
  mocks.interrupt.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("editing a user message", () => {
  it("prefills the composer and restores the previous draft on cancel", async () => {
    const userEventSetup = userEvent.setup()
    mocks.listMessages.mockResolvedValue([user("original question"), assistant("answer")])
    renderChat()

    await screen.findByText("original question")
    const composer = screen.getByTestId("composer") as HTMLTextAreaElement
    await userEventSetup.type(composer, "unfinished draft")

    await userEventSetup.click(screen.getByTestId("message-edit"))
    await waitFor(() => expect(composer).toHaveValue("original question"))
    expect(screen.getByTestId("composer-editing")).toHaveTextContent(
      "Editing a message. Sending creates a new branch.",
    )

    await userEventSetup.click(screen.getByTestId("composer-edit-cancel"))
    await waitFor(() => expect(composer).toHaveValue("unfinished draft"))
    expect(screen.queryByTestId("composer-editing")).toBeNull()
  })

  it("forks before the message, switches and sends the edited text", async () => {
    const userEventSetup = userEvent.setup()
    const fork = sessionInfo("ses_fork", "Parent chat", {
      branchOf: "ses_1",
      branchBefore: "msg_u",
    })
    mocks.listSessions
      .mockResolvedValueOnce([sessionInfo("ses_1", "Parent chat")])
      .mockResolvedValue([sessionInfo("ses_1", "Parent chat"), fork])
    mocks.listMessages.mockImplementation(async (id: string) =>
      id === "ses_1" ? [user("original question"), assistant("answer")] : [],
    )
    mocks.forkSession.mockResolvedValue(fork)
    renderChat()

    await screen.findByText("original question")
    await userEventSetup.click(screen.getByTestId("message-edit"))
    const composer = screen.getByTestId("composer")
    await userEventSetup.clear(composer)
    await userEventSetup.type(composer, "edited question")
    await userEventSetup.click(screen.getByTestId("send"))

    await waitFor(() =>
      expect(mocks.forkSession).toHaveBeenCalledWith("ses_1", "msg_u"),
    )
    await waitFor(() => expect(mocks.listMessages).toHaveBeenCalledWith("ses_fork"))
    await waitFor(() =>
      expect(mocks.prompt).toHaveBeenCalledWith("ses_fork", { text: "edited question" }),
    )
    // The branch link replaces the subagent back link, and the title is kept.
    expect(await screen.findByTestId("branch-parent-link")).toHaveAttribute("href", "/c/ses_1")
    expect(screen.getByRole("heading", { name: "Parent chat" })).toBeInTheDocument()
    expect(screen.queryByTestId("parent-link")).toBeNull()
  })
})

describe("branching from a message", () => {
  it("forks before the message and navigates to the new branch", async () => {
    const userEventSetup = userEvent.setup()
    const fork = sessionInfo("ses_fork", "Parent chat", {
      branchOf: "ses_1",
      branchBefore: "msg_u",
    })
    mocks.listSessions
      .mockResolvedValueOnce([sessionInfo("ses_1", "Parent chat")])
      .mockResolvedValue([sessionInfo("ses_1", "Parent chat"), fork])
    mocks.listMessages.mockImplementation(async (id: string) =>
      id === "ses_1"
        ? [user("original question"), assistant("answer")]
        : [user("original question")],
    )
    mocks.forkSession.mockResolvedValue(fork)
    renderChat()

    await screen.findByText("answer")
    await userEventSetup.click(screen.getByTestId("message-branch"))

    await waitFor(() =>
      expect(mocks.forkSession).toHaveBeenCalledWith("ses_1", "msg_u"),
    )
    const link = await screen.findByTestId("branch-parent-link")
    expect(link).toHaveAttribute("href", "/c/ses_1")
    expect(link).toHaveTextContent("Branch of Parent chat")
    expect(screen.getByRole("heading", { name: "Parent chat" })).toBeInTheDocument()
    // Only the history before the boundary is copied into the branch. The
    // transcript of the old chat is cleared in the session-switch effect, so
    // this settles a tick after the branch link appears.
    expect(await screen.findByText("original question")).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText("answer")).toBeNull())
    expect(screen.queryByTestId("parent-link")).toBeNull()
  })

  it("shows how many branches a message has on the parent", async () => {
    mocks.listSessions.mockResolvedValue([
      sessionInfo("ses_1", "Parent chat"),
      sessionInfo("ses_fork", "Parent chat", { branchOf: "ses_1", branchBefore: "msg_u" }),
    ])
    mocks.listMessages.mockResolvedValue([user("original question"), assistant("answer")])
    renderChat()

    const count = await screen.findByTestId("message-branch-count")
    expect(count).toHaveTextContent("1 branch")
    expect(screen.getAllByTestId("message-branch-count")).toHaveLength(1)
  })
})
