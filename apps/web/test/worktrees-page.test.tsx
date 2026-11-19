import type { WorktreeInfo, WorktreesResponse } from "@openchat/contracts"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "../src/i18n/provider"
import { WorktreesPage } from "../src/worktrees/WorktreesPage"

const fetchMock = vi.fn()

let fixture: WorktreesResponse
let dirty: Set<string>
let failLoad: boolean
let limitReached: boolean

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function worktree(directory: string, branch: string, name?: string): WorktreeInfo {
  return { directory, branch, projectID: "proj_1", ...(name ? { name } : {}) }
}

beforeEach(() => {
  dirty = new Set()
  failLoad = false
  limitReached = false
  fixture = {
    projectID: "proj_1",
    worktrees: [
      worktree("/workspace/.worktrees/notes", "feat/notes", "notes"),
      worktree("/workspace/.worktrees/release", "feat/release"),
    ],
  }

  fetchMock.mockReset()
  fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as Request).url)
    const method = init?.method ?? "GET"
    if (url.startsWith("/api/worktrees") && method === "GET") {
      if (failLoad) return json({ error: { code: "worktrees_unavailable" } }, 502)
      return json(fixture)
    }
    if (url === "/api/worktrees" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as {
        branch: string
        from?: string
        name?: string
      }
      if (limitReached) {
        return json(
          {
            error: {
              code: "worktree_limit",
              message: "This project already has the maximum number of worktrees",
            },
          },
          409,
        )
      }
      const created = worktree(
        `/workspace/.worktrees/${body.branch.replaceAll("/", "-")}`,
        body.branch,
        body.name,
      )
      fixture = { ...fixture, worktrees: [...fixture.worktrees, created] }
      return json(created, 201)
    }
    if (url.startsWith("/api/worktrees?") && method === "DELETE") {
      const params = new URL(url, "http://localhost").searchParams
      const directory = params.get("directory") ?? ""
      const force = params.get("force") === "true"
      if (dirty.has(directory) && !force) {
        return json(
          { error: { code: "worktree_dirty", message: "uncommitted changes" } },
          409,
        )
      }
      fixture = {
        ...fixture,
        worktrees: fixture.worktrees.filter((row) => row.directory !== directory),
      }
      return json({ ok: true })
    }
    throw new Error(`unexpected request: ${method} ${url}`)
  })
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderPage() {
  return render(
    <I18nProvider initialLocale="en">
      <MemoryRouter initialEntries={["/worktrees"]}>
        <WorktreesPage />
      </MemoryRouter>
    </I18nProvider>,
  )
}

function rowFor(directory: string): HTMLElement {
  const rows = screen.getAllByTestId("worktree-row")
  const match = rows.find((row) => row.textContent?.includes(directory))
  if (!match) throw new Error(`No row for ${directory}`)
  return match
}

describe("/worktrees page", () => {
  it("lists directories, branches and the resolved project", async () => {
    renderPage()

    expect(await screen.findByRole("heading", { level: 1, name: "Worktrees" })).toBeVisible()
    expect(screen.getByTestId("worktrees-note")).toHaveTextContent(
      "Parallel tasks should each run in their own worktree.",
    )
    expect(screen.getByTestId("worktrees-project")).toHaveTextContent("Project: proj_1")

    const notes = rowFor("/workspace/.worktrees/notes")
    expect(within(notes).getByTestId("worktree-branch")).toHaveTextContent("feat/notes")
    const release = rowFor("/workspace/.worktrees/release")
    expect(within(release).getByTestId("worktree-branch")).toHaveTextContent("feat/release")
  })

  it("creates a worktree from the form and shows its directory", async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByTestId("worktrees-list")

    await user.type(screen.getByLabelText("Branch"), "feat/worktrees")
    await user.type(screen.getByLabelText("Base (optional)"), "main")
    await user.click(screen.getByTestId("worktree-create-submit"))

    await waitFor(() =>
      expect(screen.getByTestId("worktrees-notice")).toHaveTextContent(
        "Worktree created: /workspace/.worktrees/feat-worktrees on feat/worktrees.",
      ),
    )
    expect(rowFor("/workspace/.worktrees/feat-worktrees")).toBeVisible()

    const createCall = fetchMock.mock.calls.find(
      (call: unknown[]) =>
        call[0] === "/api/worktrees" && (call[1] as RequestInit | undefined)?.method === "POST",
    )
    expect(JSON.parse(String((createCall?.[1] as RequestInit | undefined)?.body))).toEqual({
      branch: "feat/worktrees",
      from: "main",
    })
  })

  it("shows the uncommitted-changes refusal and only removes when forced", async () => {
    const user = userEvent.setup()
    dirty.add("/workspace/.worktrees/notes")
    renderPage()
    const notes = await screen.findByText("/workspace/.worktrees/notes")
    expect(notes).toBeVisible()

    await user.click(within(rowFor("/workspace/.worktrees/notes")).getByRole("button", { name: /Remove/ }))
    const dialog = screen.getByRole("alertdialog", { name: "Remove this worktree?" })
    expect(dialog).toHaveTextContent(
      "The removal is refused while the worktree has uncommitted changes.",
    )

    await user.click(within(dialog).getByTestId("worktree-remove-confirm"))
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The worktree has uncommitted changes. Force removal discards them.",
    )
    // The refusal did not remove the row and the dialog stays open.
    expect(rowFor("/workspace/.worktrees/notes")).toBeVisible()

    await user.click(within(dialog).getByTestId("worktree-remove-force"))
    await waitFor(() =>
      expect(screen.queryByText("/workspace/.worktrees/notes")).toBeNull(),
    )
    expect(screen.queryByRole("alertdialog")).toBeNull()

    const deleteCall = fetchMock.mock.calls.find(
      (call: unknown[]) =>
        (call[1] as RequestInit | undefined)?.method === "DELETE" &&
        String(call[0]).includes("force=true"),
    )
    const deleteUrl = String(deleteCall?.[0])
    expect(deleteUrl).toContain("force=true")
    expect(decodeURIComponent(deleteUrl)).toContain("/workspace/.worktrees/notes")
    // The first attempt was a plain removal, not a silent force.
    expect(
      fetchMock.mock.calls.some(
        (call: unknown[]) =>
          (call[1] as RequestInit | undefined)?.method === "DELETE" &&
          String(call[0]).includes("force=false"),
      ),
    ).toBe(true)
  })

  it("renders the empty state after a successful removal", async () => {
    fixture = { worktrees: [] }
    renderPage()
    expect(await screen.findByTestId("worktrees-empty")).toHaveTextContent(
      "No worktrees yet.",
    )
    expect(screen.getByTestId("worktrees-note")).toBeVisible()
  })

  it("shows a localized hint when the project holds the maximum number of worktrees", async () => {
    limitReached = true
    const user = userEvent.setup()
    renderPage()
    await screen.findByTestId("worktrees-list")

    await user.type(screen.getByLabelText("Branch"), "feat/over-limit")
    await user.click(screen.getByTestId("worktree-create-submit"))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This project already has the maximum number of worktrees. Remove one before creating another.",
    )
    expect(screen.queryByTestId("worktrees-notice")).toBeNull()
  })

  it("moves focus into the removal dialog, traps Tab, cancels on Escape and restores focus", async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByTestId("worktrees-list")

    const removeButton = within(rowFor("/workspace/.worktrees/notes")).getByRole("button", {
      name: /Remove/,
    })
    await user.click(removeButton)

    const dialog = screen.getByRole("alertdialog", { name: "Remove this worktree?" })
    const cancel = within(dialog).getByRole("button", { name: "Cancel" })
    const force = within(dialog).getByTestId("worktree-remove-force")
    // Opening the dialog lands on the safe action, not on a destructive one.
    expect(cancel).toHaveFocus()

    // Tab wraps from the last button to the first, Shift+Tab back to the last.
    force.focus()
    await user.tab()
    expect(cancel).toHaveFocus()
    await user.tab({ shift: true })
    expect(force).toHaveFocus()

    await user.keyboard("{Escape}")
    expect(screen.queryByRole("alertdialog")).toBeNull()
    expect(removeButton).toHaveFocus()
  })

  it("shows a retryable load error", async () => {
    failLoad = true
    renderPage()
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Worktrees could not be loaded.",
    )
    failLoad = false
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(await screen.findByTestId("worktrees-list")).toBeVisible()
  })
})
