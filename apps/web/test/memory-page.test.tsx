import type { ReactNode } from "react"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SessionSidebar } from "../src/chat/SessionSidebar"
import { I18nProvider } from "../src/i18n/provider"
import { MemoryPage } from "../src/pages/MemoryPage"
import { ThemeProvider } from "../src/theme/provider"

interface MemorySource {
  sessionID?: string
  messageID?: string
  at?: string
}
interface Fact {
  id: string
  kind: string
  text: string
  topic: string
  trust: string
  status: string
  source?: MemorySource
  createdAt?: string
  lastConfirmedAt?: string
}
interface AuditEntry {
  action: string
  actor: string
  at: string
  reason: string
  ids: string[]
}
interface ResponseBody {
  facts: Fact[]
  audit: AuditEntry[]
  index: string
}

const mocks = vi.hoisted(() => ({
  sessions: [] as Array<{
    id: string
    title: string
    directory: string
    created: number
    updated: number
  }>,
}))

// The sidebar needs these providers; the page itself does not. Mocking them is
// harmless here and keeps the nav-link test focused on markup.
vi.mock("../src/auth/provider", () => ({
  useAuth: () => ({
    status: "authenticated",
    user: "tester",
    signIn: vi.fn(),
    signOut: vi.fn(),
    retry: vi.fn(),
  }),
}))
vi.mock("../src/chat/sessions", () => ({
  useSessions: () => ({
    sessions: mocks.sessions,
    loading: false,
    failed: false,
    refresh: vi.fn(),
    create: vi.fn(),
  }),
}))

const fetchMock = vi.fn()
let fixture: ResponseBody
let failRead: boolean
let readGate: (() => Promise<Response>) | null

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function fact(overrides: Partial<Fact> & { id: string }): Fact {
  return {
    kind: "preference",
    text: "Plain text fact",
    topic: "general",
    trust: "explicit",
    status: "active",
    ...overrides,
  }
}

beforeEach(() => {
  mocks.sessions = []
  failRead = false
  readGate = null
  fixture = {
    facts: [
      fact({
        id: "f-1",
        text: "**Prefers** <b>UI</b> in German",
        topic: "language",
        source: { sessionID: "s-1", messageID: "m-1", at: "t0" },
        createdAt: "2026-01-01",
        lastConfirmedAt: "2026-02-01",
      }),
      fact({
        id: "f-2",
        kind: "decision",
        text: "Use plain files",
        topic: "storage",
        trust: "inferred",
        status: "superseded",
      }),
    ],
    audit: [{ action: "write", actor: "agent", at: "t1", reason: "initial", ids: ["f-1"] }],
    index: "memory index",
  }

  fetchMock.mockReset()
  fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as Request).url)
    const method = init?.method ?? "GET"

    if (url === "/api/memory" && method === "GET") {
      if (readGate) return readGate()
      if (failRead) return json({ error: { code: "memory_unavailable", message: "down" } }, 500)
      return json(fixture)
    }

    const match = /^\/api\/memory\/([^/]+)$/.exec(url)
    if (match && (method === "PATCH" || method === "DELETE")) {
      const id = decodeURIComponent(match[1] ?? "")
      if (method === "PATCH") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Partial<Fact>
        fixture = {
          ...fixture,
          facts: fixture.facts.map((entry) => (entry.id === id ? { ...entry, ...body } : entry)),
        }
        return json(fixture.facts.find((entry) => entry.id === id))
      }
      fixture = { ...fixture, facts: fixture.facts.filter((entry) => entry.id !== id) }
      return json({ ok: true })
    }

    throw new Error(`unexpected request: ${method} ${url}`)
  })
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function providers(children: ReactNode) {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale="en">
        <MemoryRouter initialEntries={["/memory"]}>{children}</MemoryRouter>
      </I18nProvider>
    </ThemeProvider>,
  )
}

function renderPage() {
  return providers(
    <Routes>
      <Route path="/memory" element={<MemoryPage />} />
    </Routes>,
  )
}

function renderSidebar() {
  return providers(<SessionSidebar />)
}

function patchCall(): RequestInit | undefined {
  return fetchMock.mock.calls.find(
    ([url, init]) => String(url).startsWith("/api/memory/") && (init as RequestInit | undefined)?.method === "PATCH",
  )?.[1] as RequestInit | undefined
}

function deleteCall(): RequestInit | undefined {
  return fetchMock.mock.calls.find(
    ([url, init]) => String(url).startsWith("/api/memory/") && (init as RequestInit | undefined)?.method === "DELETE",
  )?.[1] as RequestInit | undefined
}

describe("memory page", () => {
  it("lists facts with metadata and renders their text as plain text", async () => {
    renderPage()

    const rows = await screen.findAllByTestId("memory-row")
    expect(rows).toHaveLength(2)
    const row = rows[0]!
    expect(within(row).getByText("f-1")).toBeInTheDocument()
    expect(within(row).getByText("preference")).toBeInTheDocument()
    expect(within(row).getByText("language")).toBeInTheDocument()
    expect(within(row).getByText("Active")).toBeInTheDocument()
    expect(within(row).getByText("Explicit")).toBeInTheDocument()
    expect(within(row).getByTestId("memory-source")).toHaveTextContent("s-1 · m-1 · t0")
    expect(within(row).getByText("2026-01-01")).toBeInTheDocument()
    expect(within(row).getByText("2026-02-01")).toBeInTheDocument()

    // Markdown-looking input stays text: no <b>/<strong> element is built.
    expect(within(row).getByTestId("memory-text")).toHaveTextContent("**Prefers** <b>UI</b> in German")
    expect(document.querySelector("b")).toBeNull()
    expect(document.querySelector("strong")).toBeNull()
    expect(document.querySelector("script")).toBeNull()
    // The second fact's status is translated, not shown raw.
    expect(within(rows[1]!).getByText("Superseded")).toBeInTheDocument()
  })

  it("edits text and topic inline and saves them with PATCH", async () => {
    const user = userEvent.setup()
    renderPage()
    let row = (await screen.findAllByTestId("memory-row"))[0]!
    await user.click(within(row).getByTestId("memory-edit"))

    const text = within(row).getByTestId("memory-edit-text")
    const topic = within(row).getByTestId("memory-edit-topic")
    await user.clear(text)
    await user.type(text, "Prefers German UI")
    await user.clear(topic)
    await user.type(topic, "locale")
    await user.click(within(row).getByTestId("memory-save"))

    await waitFor(() => expect(patchCall()).toBeDefined())
    const call = patchCall()!
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url) === "/api/memory/f-1" &&
          (init as RequestInit | undefined)?.method === "PATCH",
      ),
    ).toBe(true)
    expect(JSON.parse(String(call.body))).toEqual({ text: "Prefers German UI", topic: "locale" })
    await waitFor(() =>
      expect(within(screen.getAllByTestId("memory-row")[0]!).getByText("Prefers German UI")).toBeInTheDocument(),
    )
  })

  it("requires a reason and confirms deletion with DELETE", async () => {
    const user = userEvent.setup()
    renderPage()
    const row = (await screen.findAllByTestId("memory-row"))[0]!
    await user.click(within(row).getByTestId("memory-delete-toggle"))

    const confirm = within(row).getByTestId("memory-delete")
    expect(confirm).toBeDisabled()
    await user.type(within(row).getByTestId("memory-delete-reason"), "no longer true")
    expect(confirm).toBeEnabled()
    await user.click(confirm)

    await waitFor(() => expect(deleteCall()).toBeDefined())
    expect(JSON.parse(String(deleteCall()!.body))).toEqual({ reason: "no longer true" })
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url) === "/api/memory/f-1" &&
          (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(true)
    await waitFor(() => expect(screen.getAllByTestId("memory-row")).toHaveLength(1))
  })

  it("renders the audit trail with actor, action and reason", async () => {
    renderPage()
    const audit = await screen.findByTestId("memory-audit")
    expect(within(audit).getByRole("columnheader", { name: "Reason" })).toBeInTheDocument()
    expect(within(audit).getByText("agent")).toBeInTheDocument()
    expect(within(audit).getByText("write")).toBeInTheDocument()
    expect(within(audit).getByText("f-1")).toBeInTheDocument()
    expect(within(audit).getByText("initial")).toBeInTheDocument()
  })

  it("exposes the JSON export as a download link", async () => {
    renderPage()
    const link = await screen.findByTestId("memory-export")
    expect(link).toHaveAttribute("href", "/api/memory/export")
    expect(link).toHaveAttribute("download")
  })

  it("shows an empty state when there are no facts", async () => {
    fixture.facts = []
    fixture.audit = []
    renderPage()
    expect(await screen.findByTestId("memory-empty")).toHaveTextContent("No memory facts yet.")
    expect(screen.queryByTestId("memory-row")).toBeNull()
    expect(within(screen.getByTestId("memory-audit")).getByText("No changes recorded yet.")).toBeInTheDocument()
  })

  it("reports a failed read and retries it", async () => {
    const user = userEvent.setup()
    failRead = true
    renderPage()
    expect(await screen.findByTestId("memory-error")).toHaveTextContent("Memory could not be loaded.")
    failRead = false
    await user.click(screen.getByRole("button", { name: "Retry" }))
    expect((await screen.findAllByTestId("memory-row")).length).toBeGreaterThan(0)
  })

  it("announces loading while the first read is in flight", async () => {
    let release!: (value: Response) => void
    readGate = () => new Promise<Response>((done) => (release = done))
    renderPage()
    expect(await screen.findByTestId("memory-loading")).toHaveTextContent("Loading memory…")
    await act(async () => release(json(fixture)))
    expect((await screen.findAllByTestId("memory-row")).length).toBeGreaterThan(0)
  })
})

describe("memory navigation", () => {
  it("shows an always-visible Memory link in the main navigation", () => {
    mocks.sessions = []
    renderSidebar()
    const nav = screen.getByRole("navigation", { name: "Main navigation" })
    const link = within(nav).getByTestId("nav-memory")
    expect(link).toHaveAttribute("href", "/memory")
    expect(link).toHaveTextContent("Memory")
  })
})
