import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"
import { AppShell } from "../src/components/AppShell"
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

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function renderShell() {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale="en">
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<p>main content</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </ThemeProvider>,
  )
}

describe("sidebar drawer", () => {
  it("is modal, traps focus, inerts the content and restores focus on Escape", async () => {
    const user = userEvent.setup()
    renderShell()

    const trigger = screen.getByRole("button", { name: "Open chat list" })
    const content = screen.getByTestId("app-content")
    expect(content).not.toHaveAttribute("inert")

    await user.click(trigger)

    const dialog = screen.getByRole("dialog", { name: "Chat sessions" })
    expect(dialog).toHaveAttribute("aria-modal", "true")
    expect(content).toHaveAttribute("inert")

    const first = dialog.querySelector<HTMLElement>(FOCUSABLE)
    expect(first).not.toBeNull()
    expect(first).toHaveFocus()

    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
    const last = focusable[focusable.length - 1]
    expect(last).toBeDefined()

    last?.focus()
    fireEvent.keyDown(window, { key: "Tab" })
    expect(first).toHaveFocus()

    first?.focus()
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true })
    expect(last).toHaveFocus()

    fireEvent.keyDown(window, { key: "Escape" })

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(content).not.toHaveAttribute("inert")
    await waitFor(() => expect(trigger).toHaveFocus())
  })
})
