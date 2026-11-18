import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { SessionSidebar } from "../src/chat/SessionSidebar"
import { I18nProvider } from "../src/i18n/provider"
import { ThemeProvider } from "../src/theme/provider"

const mocks = vi.hoisted(() => ({
  sessions: [] as Array<{
    id: string
    title: string
    directory: string
    created: number
    updated: number
  }>,
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
    sessions: mocks.sessions,
    loading: false,
    failed: false,
    refresh: vi.fn(),
    create: vi.fn(),
  }),
}))

beforeEach(() => {
  mocks.sessions = []
})

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

describe("sidebar search entry", () => {
  it("links to /search from inside the navigation landmark", () => {
    renderSidebar()

    const nav = screen.getByRole("navigation", { name: "Main navigation" })
    // The multi-source surface is the explicit scope; bare /search stays chat-only.
    expect(within(nav).getByRole("link", { name: "Search" })).toHaveAttribute(
      "href",
      "/search?scope=all",
    )
  })
})

describe("sidebar title filter", () => {
  it("filters the loaded chats without leaving the sidebar", async () => {
    mocks.sessions = [
      { id: "ses_a", title: "Alpha notes", directory: "/w", created: 1, updated: 2 },
      { id: "ses_b", title: "Beta plan", directory: "/w", created: 2, updated: 1 },
    ]
    const user = userEvent.setup()
    renderSidebar()

    expect(screen.getAllByTestId("session-item")).toHaveLength(2)
    const filter = screen.getByLabelText("Filter chats by title")

    await user.type(filter, "alpha")
    expect(screen.getByText("Alpha notes")).toBeVisible()
    expect(screen.queryByText("Beta plan")).toBeNull()

    await user.clear(filter)
    expect(screen.getByText("Beta plan")).toBeVisible()

    await user.type(filter, "gamma")
    expect(screen.getByText("No chats match this filter.")).toBeVisible()
    expect(screen.queryAllByTestId("session-item")).toHaveLength(0)
  })
})
