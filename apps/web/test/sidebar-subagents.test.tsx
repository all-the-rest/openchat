import type { SessionInfo } from "@openchat/contracts"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"
import { SessionSidebar } from "../src/chat/SessionSidebar"
import { EXPANDED_SESSIONS_STORAGE_KEY } from "../src/chat/session-groups"
import { I18nProvider } from "../src/i18n/provider"
import { ThemeProvider } from "../src/theme/provider"

const state = vi.hoisted(() => ({
  sessions: [] as SessionInfo[],
}))

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
    sessions: state.sessions,
    loading: false,
    failed: false,
    refresh: vi.fn(),
    create: vi.fn(),
  }),
}))

function session(id: string, title: string, parentID?: string): SessionInfo {
  return { id, title, directory: "/workspace", created: 1, updated: 1, parentID }
}

function renderSidebar() {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale="en">
        <MemoryRouter>
          <SessionSidebar />
        </MemoryRouter>
      </I18nProvider>
    </ThemeProvider>,
  )
}

describe("subagent sessions in the sidebar", () => {
  it("collapses a parent's children by default and expands them with the keyboard", async () => {
    const user = userEvent.setup()
    state.sessions = [
      session("ses_parent", "Quarterly report review"),
      session("ses_child", "Agent: check the figures", "ses_parent"),
    ]
    renderSidebar()

    expect(screen.getAllByTestId("session-item")).toHaveLength(1)
    expect(screen.getByText(/in Quarterly report review/)).toBeInTheDocument()

    const toggle = screen.getByTestId("session-children-toggle")
    const children = screen.getByTestId("session-children")
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(toggle).toHaveTextContent("1")
    expect(children).toHaveAttribute("hidden")

    toggle.focus()
    await user.keyboard("{Enter}")

    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(children).not.toHaveAttribute("hidden")
    expect(window.localStorage.getItem(EXPANDED_SESSIONS_STORAGE_KEY)).toBe(
      JSON.stringify(["ses_parent"]),
    )
  })

  it("restores an expanded group on the next mount", async () => {
    const user = userEvent.setup()
    state.sessions = [
      session("ses_parent", "Quarterly report review"),
      session("ses_child", "Agent: check the figures", "ses_parent"),
    ]
    const first = renderSidebar()
    await user.click(screen.getByTestId("session-children-toggle"))
    first.unmount()

    renderSidebar()
    expect(screen.getByTestId("session-children-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    )
    expect(screen.getByTestId("session-children")).not.toHaveAttribute("hidden")
  })

  it("renders an orphan child at the top with a neutral badge and no toggle", () => {
    state.sessions = [session("ses_orphan", "Agent: lost parent", "ses_missing")]
    renderSidebar()

    const row = screen.getByTestId("session-item")
    expect(row).toHaveTextContent("Agent: lost parent")
    expect(screen.getByTestId("session-orphan-badge")).toHaveTextContent("Agent")
    expect(screen.getByTestId("session-orphan-badge")).toHaveClass("badge-ghost")
    expect(screen.queryByTestId("session-children-toggle")).toBeNull()
  })
})
