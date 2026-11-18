import type { SessionInfo } from "@openchat/contracts"
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { SessionsProvider, useSessions } from "../src/chat/sessions"

const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  createSession: vi.fn(),
}))

vi.mock("../src/api/client", () => ({ api: mocks }))

vi.mock("../src/code/SurfaceProvider", () => ({
  useSurfaceOrNull: () => null,
}))

function session(id: string): SessionInfo {
  return { id, title: id, directory: "/workspace", created: 1, updated: 1 }
}

function Probe() {
  const { sessions, create } = useSessions()
  return (
    <div>
      <button type="button" onClick={() => void create()}>
        create
      </button>
      <ul>
        {sessions.map((entry) => (
          <li key={entry.id}>{entry.id}</li>
        ))}
      </ul>
    </div>
  )
}

describe("SessionsProvider", () => {
  it("keeps a just-created session when an older list request lands late", async () => {
    let resolveList: (rows: SessionInfo[]) => void = () => {}
    mocks.listSessions.mockReturnValue(
      new Promise<SessionInfo[]>((resolve) => {
        resolveList = resolve
      }),
    )
    mocks.createSession.mockResolvedValue(session("ses_new"))

    render(
      <SessionsProvider>
        <Probe />
      </SessionsProvider>,
    )

    await userEvent.click(screen.getByRole("button", { name: "create" }))
    expect(screen.getByText("ses_new")).toBeInTheDocument()

    // The list request started before the create; the host did not know the
    // new session yet. It must not remove the row the user just opened.
    await act(async () => {
      resolveList([session("ses_old")])
    })

    expect(screen.getByText("ses_old")).toBeInTheDocument()
    expect(screen.getByText("ses_new")).toBeInTheDocument()
  })

  it("replaces the list once the host reports the created session", async () => {
    mocks.listSessions.mockResolvedValue([session("ses_new")])
    mocks.createSession.mockResolvedValue(session("ses_new"))

    render(
      <SessionsProvider>
        <Probe />
      </SessionsProvider>,
    )

    await userEvent.click(screen.getByRole("button", { name: "create" }))
    expect(screen.getAllByText("ses_new")).toHaveLength(1)
  })
})
