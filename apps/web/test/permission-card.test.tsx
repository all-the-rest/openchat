import type { PermissionRequest } from "@openchat/contracts"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventStreamProvider } from "../src/api/events"
import { PermissionCard } from "../src/chat/PermissionCard"
import type { PermissionValue } from "../src/chat/permissions"
import { usePermissions } from "../src/chat/permissions"
import { SessionsProvider } from "../src/chat/sessions"
import { I18nProvider } from "../src/i18n/provider"
import { ChatPage } from "../src/pages/ChatPage"
import { ThemeProvider } from "../src/theme/provider"

const mocks = vi.hoisted(() => ({
  listMessages: vi.fn(async () => []),
  listInbox: vi.fn(async () => []),
  listSessions: vi.fn(async () => []),
  chatFiles: vi.fn(async () => ({
    files: [],
    quota: { usedBytes: 0, quotaBytes: 1024, totalUsedBytes: 0, totalQuotaBytes: 4096 },
  })),
  listPermissions: vi.fn(async (): Promise<PermissionRequest[]> => []),
  replyPermission: vi.fn(async () => undefined),
  prompt: vi.fn(async () => ({ ok: true, messageID: "msg_1" })),
  info: vi.fn(async () => ({
    dictation: { enabled: false, maxSeconds: 60, maxBytes: 1024 },
  })),
  models: vi.fn(async () => []),
  agents: vi.fn(async () => []),
}))

vi.mock("../src/api/client", () => ({ api: mocks }))

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

function source(): FakeEventSource {
  const found = FakeEventSource.instances.at(-1)
  if (!found) throw new Error("EventSource was not created")
  return found
}

const request = {
  id: "per_1",
  sessionID: "ses_1",
  tool: "bash",
  action: "Run pnpm test",
  resources: ["pnpm test"],
}

const value: PermissionValue = {
  requests: [request],
  pending: true,
  busy: false,
  failure: false,
  reply: vi.fn(async () => true),
}

function withI18n(children: ReactNode) {
  return <I18nProvider initialLocale="en">{children}</I18nProvider>
}

function renderChat() {
  return render(
    withI18n(
      <ThemeProvider initialTheme="dark">
        <SessionsProvider>
          <EventStreamProvider>
            <MemoryRouter initialEntries={["/c/ses_1"]}>
              <Routes>
                <Route path="/c/:sessionId" element={<ChatPage />} />
              </Routes>
            </MemoryRouter>
          </EventStreamProvider>
        </SessionsProvider>
      </ThemeProvider>,
    ),
  )
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal("EventSource", FakeEventSource)
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.listMessages.mockResolvedValue([])
  mocks.listInbox.mockResolvedValue([])
  mocks.listSessions.mockResolvedValue([])
  mocks.listPermissions.mockResolvedValue([])
  mocks.replyPermission.mockResolvedValue(undefined)
  models(mocks)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// The catalogue mocks are shared with the completion slice; keep their shape.
function models(target: typeof mocks): void {
  target.models.mockResolvedValue([])
  target.agents.mockResolvedValue([])
  target.info.mockResolvedValue({
    dictation: { enabled: false, maxSeconds: 60, maxBytes: 1024 },
  })
  target.chatFiles.mockResolvedValue({
    files: [],
    quota: { usedBytes: 0, quotaBytes: 1024, totalUsedBytes: 0, totalQuotaBytes: 4096 },
  })
}

describe("permission card", () => {
  it("shows the tool, the request and three decision buttons", () => {
    render(withI18n(<PermissionCard value={value} />))
    expect(screen.getByText("Permission required")).toBeInTheDocument()
    expect(screen.getByText("bash requests:")).toBeInTheDocument()
    expect(screen.getByText("Run pnpm test")).toBeInTheDocument()
    expect(screen.getByText("Resources: pnpm test")).toBeInTheDocument()
    expect(screen.getByTestId("permission-allow-once")).toBeInTheDocument()
    expect(screen.getByTestId("permission-allow-always")).toBeInTheDocument()
    expect(screen.getByTestId("permission-deny")).toBeInTheDocument()
  })

  it("keeps every decision in the tab order and replies with the chosen one", async () => {
    const user = userEvent.setup()
    const reply = vi.fn(async () => true)
    render(withI18n(<PermissionCard value={{ ...value, reply }} />))

    await user.tab()
    expect(screen.getByTestId("permission-allow-once")).toHaveFocus()
    await user.tab()
    expect(screen.getByTestId("permission-allow-always")).toHaveFocus()
    await user.tab()
    expect(screen.getByTestId("permission-deny")).toHaveFocus()
    await user.keyboard("{Enter}")

    expect(reply).toHaveBeenCalledWith("per_1", "deny")
    expect(screen.getByTestId("permission-allow-once")).toBeInTheDocument()
  })

  it("loads a pending request and removes it on a replied event", async () => {
    mocks.listPermissions.mockResolvedValue([request])
    function Probe() {
      const permissions = usePermissions("ses_1")
      return <span data-testid="count">{permissions.requests.length}</span>
    }
    render(
      withI18n(
        <EventStreamProvider>
          <Probe />
        </EventStreamProvider>,
      ),
    )

    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"))
    source().emit("permission.replied", { sessionID: "ses_1", requestID: "per_1" })
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("0"))
  })
})

describe("permission and sending", () => {
  it("blocks the composer until the ask is answered and notes a denial", async () => {
    const user = userEvent.setup()
    renderChat()
    await waitFor(() => expect(source()).toBeDefined())
    await user.type(screen.getByTestId("composer"), "hello")
    expect(screen.getByTestId("send")).toBeEnabled()

    source().emit("permission.asked", {
      sessionID: "ses_1",
      id: "per_1",
      tool: "bash",
      action: "Run pnpm test",
      resources: ["pnpm test"],
    })
    const card = await screen.findByTestId("permission-card")
    expect(card).toBeInTheDocument()
    expect(screen.getByTestId("send")).toBeDisabled()

    await user.click(screen.getByTestId("permission-deny"))
    await waitFor(() =>
      expect(mocks.replyPermission).toHaveBeenCalledWith("ses_1", "per_1", "deny"),
    )

    source().emit("permission.replied", {
      sessionID: "ses_1",
      requestID: "per_1",
      decision: "deny",
    })
    await waitFor(() => expect(screen.queryByTestId("permission-card")).not.toBeInTheDocument())
    expect(screen.getByTestId("send")).toBeEnabled()
    expect(await screen.findByText("Denied bash")).toBeInTheDocument()
  })
})
