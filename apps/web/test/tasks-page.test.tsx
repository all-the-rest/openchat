import type { BackgroundJob, Schedule, SessionInfo } from "@openchat/contracts"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "../src/i18n/provider"
import { TasksPage } from "../src/tasks/TasksPage"

const fetchMock = vi.fn()

const session: SessionInfo = {
  id: "ses_1",
  title: "Notes",
  directory: "/workspace",
  created: 1_000,
  updated: 1_000,
}

const schedule: Schedule = {
  id: "sch_1",
  sessionID: session.id,
  title: "Weekly summary",
  prompt: "Summarise the notes",
  status: "active",
  nextRunAt: Date.parse("2026-11-20T09:30:00Z"),
  endsAt: Date.parse("2026-11-20T09:30:00Z"),
  runCount: 1,
  created: 1_000,
  updated: 1_000,
}

const jobs: BackgroundJob[] = [
  {
    id: "job_done",
    sessionID: session.id,
    kind: "shell",
    status: "completed",
    started: 2_000,
    finished: 3_000,
  },
  {
    id: "job_run",
    sessionID: session.id,
    kind: "subagent",
    status: "running",
    started: 1_000,
    title: "Review the diff",
  },
]

let sessions: SessionInfo[]
let schedules: Schedule[]
let jobRows: BackgroundJob[]
let failLoad: boolean
let failAction: boolean

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

beforeEach(() => {
  sessions = []
  schedules = []
  jobRows = []
  failLoad = false
  failAction = false

  fetchMock.mockReset()
  fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as Request).url)
    const method = init?.method ?? "GET"
    if (failLoad && method === "GET") return json({ error: { code: "unavailable" } }, 503)

    if (url === "/api/sessions" && method === "GET") return json(sessions)
    if (url === "/api/jobs" && method === "GET") return json(jobRows)
    const scheduleMatch = /^\/api\/sessions\/([^/]+)\/schedules$/.exec(url)
    if (scheduleMatch && method === "GET") {
      return json(schedules.filter((row) => row.sessionID === scheduleMatch[1]))
    }
    if (scheduleMatch && method === "POST") {
      if (failAction) return json({ error: { code: "invalid_request" } }, 400)
      const body = JSON.parse(String(init?.body)) as { prompt: string; ends: { after?: string } }
      const created: Schedule = {
        id: "sch_new",
        sessionID: scheduleMatch[1] ?? "",
        title: body.prompt,
        prompt: body.prompt,
        status: "active",
        runCount: 0,
        created: 5_000,
        updated: 5_000,
      }
      schedules = [...schedules, created]
      return json(created, 201)
    }
    const actionMatch = /^\/api\/schedules\/([^/]+)\/(pause|resume)$/.exec(url)
    if (actionMatch && method === "POST") {
      if (failAction) return json({ error: { code: "unavailable" } }, 400)
      schedules = schedules.map((row) =>
        row.id === actionMatch[1]
          ? { ...row, status: actionMatch[2] === "pause" ? "paused" : "active" }
          : row,
      )
      return json(schedules.find((row) => row.id === actionMatch[1]))
    }
    const deleteMatch = /^\/api\/schedules\/([^/]+)$/.exec(url)
    if (deleteMatch && method === "DELETE") {
      schedules = schedules.filter((row) => row.id !== deleteMatch[1])
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
    <I18nProvider initialLocale="en">
      <MemoryRouter initialEntries={["/tasks"]}>{children}</MemoryRouter>
    </I18nProvider>,
  )
}

function renderPage() {
  return providers(
    <Routes>
      <Route path="/tasks" element={<TasksPage />} />
      <Route path="/c/:sessionId" element={<p>chat thread</p>} />
    </Routes>,
  )
}

describe("/tasks page", () => {
  it("renders the server note and both empty sections", async () => {
    renderPage()
    expect(await screen.findByRole("heading", { level: 1, name: "Tasks" })).toBeVisible()
    expect(screen.getByRole("note")).toHaveTextContent(
      "Scheduled tasks run on the server even when the browser is closed.",
    )
    expect(screen.getByTestId("tasks-schedules-empty")).toBeVisible()
    expect(screen.getByTestId("tasks-jobs-empty")).toBeVisible()
    expect(screen.getByTestId("tasks-create-form")).toBeVisible()
    expect(screen.getByText("Create a chat before scheduling a task.")).toBeVisible()
  })

  it("renders schedules, session links and jobs with running first", async () => {
    sessions = [session]
    schedules = [schedule]
    jobRows = jobs
    renderPage()

    const row = await screen.findByTestId("tasks-schedule")
    expect(within(row).getByText("Weekly summary")).toBeVisible()
    expect(within(row).getByTestId("tasks-schedule-status")).toHaveTextContent("Active")
    expect(within(row).getByTestId("tasks-schedule-session")).toHaveAttribute("href", "/c/ses_1")
    expect(within(row).getByText(/Next run:/)).toBeVisible()
    expect(within(row).getByText(/Ends:/)).toBeVisible()

    const jobList = await screen.findByTestId("tasks-job-list")
    const jobItems = within(jobList).getAllByTestId("tasks-job")
    const first = jobItems[0]
    if (!first) throw new Error("Expected a first job")
    expect(first).toHaveTextContent("Subagent")
    expect(first).toHaveTextContent("Review the diff")
    expect(jobItems).toHaveLength(2)
  })

  it("pauses, resumes and deletes only after confirmation", async () => {
    const user = userEvent.setup()
    sessions = [session]
    schedules = [{ ...schedule }]
    renderPage()
    const row = await screen.findByTestId("tasks-schedule")

    await user.click(within(row).getByTestId("tasks-pause"))
    await waitFor(() => expect(within(row).getByTestId("tasks-schedule-status")).toHaveTextContent("Paused"))
    await user.click(within(row).getByTestId("tasks-resume"))
    await waitFor(() => expect(within(row).getByTestId("tasks-schedule-status")).toHaveTextContent("Active"))

    await user.click(within(row).getByTestId("tasks-delete"))
    expect(within(row).getByTestId("tasks-delete-confirm")).toBeVisible()
    await user.click(within(row).getByTestId("tasks-delete-cancel"))
    expect(within(row).queryByTestId("tasks-delete-confirm")).toBeNull()

    await user.click(within(row).getByTestId("tasks-delete"))
    await user.click(within(row).getByTestId("tasks-delete-confirm"))
    await waitFor(() => expect(screen.queryByTestId("tasks-schedule")).toBeNull())
  })

  it("creates a schedule from the form", async () => {
    const user = userEvent.setup()
    sessions = [session]
    renderPage()
    await screen.findByTestId("tasks-create-form")
    await user.type(screen.getByTestId("tasks-create-prompt"), "Check the build")
    await user.click(screen.getByTestId("tasks-create-submit"))

    await waitFor(() => expect(screen.getByTestId("tasks-create-notice")).toHaveTextContent("Schedule created."))
    expect(await screen.findByTestId("tasks-schedule")).toHaveTextContent("Check the build")
    const createCall = fetchMock.mock.calls.find(
      (call: unknown[]) =>
        String(call[0]).includes("/schedules") &&
        (call[1] as RequestInit | undefined)?.method === "POST",
    ) as unknown[] | undefined
    const createInit = createCall?.[1] as RequestInit | undefined
    expect(JSON.parse(String(createInit?.body))).toEqual({
      prompt: "Check the build",
      ends: { after: "30 minutes" },
    })
  })

  it("shows a retryable load error and an action error", async () => {
    const user = userEvent.setup()
    failLoad = true
    renderPage()
    expect(await screen.findByRole("alert")).toHaveTextContent("Tasks could not be loaded.")
    failLoad = false
    sessions = [session]
    schedules = [{ ...schedule }]
    await user.click(screen.getByRole("button", { name: "Retry" }))
    await screen.findByTestId("tasks-schedule")

    failAction = true
    await user.click(await screen.findByTestId("tasks-pause"))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The action failed. The schedule did not change.",
    )
  })
})
