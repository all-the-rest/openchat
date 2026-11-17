import { render, screen, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"
import { SessionSidebar } from "../src/chat/SessionSidebar"
import { I18nProvider } from "../src/i18n/provider"
import { ThemeProvider } from "../src/theme/provider"

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
    sessions: [],
    loading: false,
    failed: false,
    refresh: vi.fn(),
    create: vi.fn(),
  }),
}))

describe("sidebar search entry", () => {
  it("links to /search from inside the navigation landmark", () => {
    render(
      <ThemeProvider initialTheme="dark">
        <I18nProvider initialLocale="en">
          <MemoryRouter>
            <SessionSidebar />
          </MemoryRouter>
        </I18nProvider>
      </ThemeProvider>,
    )

    const nav = screen.getByRole("navigation", { name: "Main navigation" })
    // The multi-source surface is the explicit scope; bare /search stays chat-only.
    expect(within(nav).getByRole("link", { name: "Search" })).toHaveAttribute(
      "href",
      "/search?scope=all",
    )
  })
})
