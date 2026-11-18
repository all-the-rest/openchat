import type { MemoryFact } from "@openchat/contracts"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "../src/i18n/provider"
import { MemoryPage } from "../src/memory/MemoryPage"

const fetchMock = vi.fn()

function fact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: "mem_aaaaaaaa",
    text: "Prefers German UI and English docs",
    topic: "preference.language",
    tags: ["i18n"],
    source: { sessionID: "ses_1", messageID: "msg_1", at: "2026-11-18T10:00:00.000Z" },
    trust: "explicit",
    status: "active",
    supersedes: [],
    createdAt: "2026-11-18T10:00:00.000Z",
    lastConfirmedAt: "2026-11-18T10:00:00.000Z",
    expiresAt: "2027-11-18T10:00:00.000Z",
    checksum: "0".repeat(64),
    ...overrides,
  }
}

let facts: MemoryFact[]
let failWrite: boolean

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function stats() {
  return {
    total: facts.length,
    active: facts.filter((row) => row.status === "active").length,
    superseded: 0,
    expired: 0,
    deleted: 0,
    bytes: 100,
    totalBytesCap: 1_000,
    entryBytesCap: 100,
    topics: [...new Set(facts.map((row) => row.topic))],
    indexChars: 120,
    indexTokens: 30,
  }
}

beforeEach(() => {
  facts = [
    fact(),
    fact({
      id: "mem_bbbbbbbb",
      text: "Deploys with Caddy on Hetzner",
      topic: "project.deploy",
      tags: ["hosting"],
    }),
  ]
  failWrite = false

  fetchMock.mockReset()
  fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as Request).url)
    const method = init?.method ?? "GET"
    if (url === "/api/memory" && method === "GET") {
      return json({ facts, stats: stats() })
    }
    if (url === "/api/memory/index" && method === "GET") {
      return json({ index: "# Memory index\n- Deploys with Caddy\n", chars: 38, tokens: 10 })
    }
    if (url.startsWith("/api/memory/audit") && method === "GET") {
      return json({
        entries: [
          {
            at: "2026-11-18T10:00:00.000Z",
            actor: "owner",
            action: "write",
            ids: ["mem_aaaaaaaa"],
            reason: "preference.language",
          },
        ],
      })
    }
    if (url === "/api/memory" && method === "POST") {
      if (failWrite) return json({ error: { code: "memory_secret_rejected" } }, 400)
      const body = JSON.parse(String(init?.body)) as { text: string; topic: string }
      const created = fact({ id: "mem_cccccccc", text: body.text, topic: body.topic })
      facts = [...facts, created]
      return json({ fact: created }, 201)
    }
    const patch = /^\/api\/memory\/([^/]+)$/.exec(url)
    if (patch && method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as { text: string }
      facts = facts.map((row) => (row.id === patch[1] ? { ...row, text: body.text } : row))
      return json({ fact: facts.find((row) => row.id === patch[1]) })
    }
    if (patch && method === "DELETE") {
      const body = JSON.parse(String(init?.body)) as { reason: string }
      expect(body.reason.length).toBeGreaterThan(0)
      facts = facts.filter((row) => row.id !== patch[1])
      return json({ deleted: true })
    }
    throw new Error(`unexpected request: ${method} ${url}`)
  })
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderPage(locale: "en" | "de" = "en") {
  return render(
    <I18nProvider initialLocale={locale}>
      <MemoryRouter initialEntries={["/memory"]}>
        <Routes>
          <Route path="/memory" element={<MemoryPage />} />
          <Route path="/c/:sessionId" element={<p>chat thread</p>} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  )
}

function row(topic: string): HTMLElement {
  const found = screen.getAllByTestId("memory-fact").find((element) => element.dataset.topic === topic)
  if (!found) throw new Error(`no memory row for ${topic}`)
  return found
}

describe("memory page", () => {
  it("groups facts by topic and links provenance to the session", async () => {
    renderPage()
    expect(await screen.findByRole("heading", { level: 1, name: "Memory" })).toBeVisible()
    expect(screen.getByTestId("memory-count")).toHaveTextContent("2 active facts")
    expect(screen.getByRole("heading", { level: 2, name: "preference.language" })).toBeVisible()
    expect(screen.getByRole("heading", { level: 2, name: "project.deploy" })).toBeVisible()
    expect(within(row("preference.language")).getByTestId("memory-fact-source")).toHaveAttribute(
      "href",
      "/c/ses_1",
    )
  })

  it("filters by text, topic and tag", async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole("heading", { level: 1, name: "Memory" })

    await user.type(screen.getByTestId("memory-search"), "caddy")
    await waitFor(() => expect(screen.getAllByTestId("memory-fact")).toHaveLength(1))
    expect(screen.getByText("Deploys with Caddy on Hetzner")).toBeVisible()

    await user.clear(screen.getByTestId("memory-search"))
    await user.type(screen.getByTestId("memory-search"), "i18n")
    await waitFor(() => expect(screen.getAllByTestId("memory-fact")).toHaveLength(1))
    expect(screen.getByText("Prefers German UI and English docs")).toBeVisible()

    await user.clear(screen.getByTestId("memory-search"))
    await user.type(screen.getByTestId("memory-search"), "nothing-matches")
    expect(await screen.findByTestId("memory-search-empty")).toBeVisible()
  })

  it("adds a fact through the form", async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole("heading", { level: 1, name: "Memory" })

    await user.type(screen.getByTestId("memory-add-text"), "Uses pnpm workspaces")
    await user.type(screen.getByTestId("memory-add-topic"), "project.build")
    await user.selectOptions(screen.getByTestId("memory-add-trust"), "observed")
    await user.click(screen.getByTestId("memory-add-submit"))

    expect(await screen.findByText("Uses pnpm workspaces")).toBeVisible()
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      text: "Uses pnpm workspaces",
      topic: "project.build",
      trust: "observed",
    })
  })

  it("shows a translated error when the write is rejected", async () => {
    failWrite = true
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole("heading", { level: 1, name: "Memory" })
    await user.type(screen.getByTestId("memory-add-text"), "token sk-abcdefghijklmnop1234")
    await user.type(screen.getByTestId("memory-add-topic"), "secret")
    await user.click(screen.getByTestId("memory-add-submit"))
    expect(await screen.findByTestId("memory-add-error")).toHaveTextContent(
      "Looks like a secret; remove the credential.",
    )
  })

  it("edits a fact inline", async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole("heading", { level: 1, name: "Memory" })
    const target = row("preference.language")

    await user.click(within(target).getByTestId("memory-fact-edit"))
    const textarea = within(target).getByTestId("memory-edit-text")
    await user.clear(textarea)
    await user.type(textarea, "Prefers German UI only")
    await user.click(within(target).getByRole("button", { name: "Save" }))

    expect(await screen.findByText("Prefers German UI only")).toBeVisible()
  })

  it("deletes with a required reason", async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole("heading", { level: 1, name: "Memory" })
    const target = row("project.deploy")

    await user.click(within(target).getByTestId("memory-fact-delete"))
    await user.click(within(target).getByTestId("memory-delete-submit"))
    expect(within(target).getByText("A reason is required.")).toBeVisible()

    await user.type(within(target).getByTestId("memory-delete-reason"), "project ended")
    await user.click(within(target).getByTestId("memory-delete-submit"))
    await waitFor(() => expect(screen.queryByText("Deploys with Caddy on Hetzner")).toBeNull())
  })

  it("previews the index and exposes the export", async () => {
    renderPage()
    await screen.findByRole("heading", { level: 1, name: "Memory" })
    expect(screen.getByTestId("memory-index")).toHaveTextContent("# Memory index")
    expect(screen.getByTestId("memory-export")).toHaveAttribute("href", "/api/memory/export")
    expect(screen.getByTestId("memory-audit")).toHaveTextContent("write by owner")
  })

  it("renders German strings", async () => {
    renderPage("de")
    expect(await screen.findByRole("heading", { level: 1, name: "Gedächtnis" })).toBeVisible()
    expect(screen.getByTestId("memory-add-submit")).toHaveTextContent("Fakt hinzufügen")
  })
})
