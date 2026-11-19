import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SurfaceProvider, useSurface } from "../src/code/SurfaceProvider"
import { AppShell } from "../src/components/AppShell"
import { I18nProvider } from "../src/i18n/provider"
import { ThemeProvider } from "../src/theme/provider"

const mocks = vi.hoisted(() => ({ info: vi.fn() }))

vi.mock("../src/api/client", () => ({ api: mocks }))

beforeEach(() => {
  mocks.info.mockResolvedValue({ code: { configured: true, expectedVersion: "2" } })
})

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

/** Stubs the viewport: only the wide layout reports a match. */
function stubViewport(wide: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: wide && query.includes("min-width: 1024px"),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Shows the info-driven state that decides whether the entry renders. */
function AvailabilityProbe() {
  const { appsAvailable, artifactsAvailable, configured } = useSurface()
  return (
    <>
      <output data-testid="apps-availability">{String(appsAvailable)}</output>
      <output data-testid="artifacts-availability">{String(artifactsAvailable)}</output>
      <output data-testid="code-availability">{String(configured)}</output>
    </>
  )
}

function renderShell(probe?: ReactNode) {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale="en">
        <MemoryRouter initialEntries={["/"]}>
          <SurfaceProvider>
            {probe}
            <Routes>
              <Route element={<AppShell />}>
                <Route index element={<p>main content</p>} />
                <Route path="worktrees" element={<p>worktrees page</p>} />
              </Route>
            </Routes>
          </SurfaceProvider>
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

  it("keeps the closed drawer out of the tab order on a small viewport", async () => {
    const user = userEvent.setup()
    stubViewport(false)
    renderShell()

    const drawer = screen.getByTestId("app-drawer")
    expect(drawer).toHaveAttribute("inert")
    expect(drawer.querySelector(FOCUSABLE)).toBeNull()

    const trigger = screen.getByRole("button", { name: "Open chat list" })
    trigger.focus()
    await user.tab({ shift: true })
    expect(drawer.contains(document.activeElement)).toBe(false)

    trigger.focus()
    await user.tab()
    expect(document.activeElement).not.toBe(trigger)
    expect(drawer.contains(document.activeElement)).toBe(false)
  })

  it("keeps the sidebar links reachable on a wide viewport", async () => {
    stubViewport(true)
    renderShell()

    const drawer = screen.getByTestId("app-drawer")
    expect(drawer).not.toHaveAttribute("inert")

    const newChat = await screen.findByTestId("new-chat")
    newChat.focus()
    expect(newChat).toHaveFocus()
    expect(drawer.contains(newChat)).toBe(true)
  })
})

describe("sidebar artifacts entry", () => {
  it("links to /artifacts when the host reports the artifact surface", async () => {
    stubViewport(true)
    mocks.info.mockResolvedValue({
      code: { configured: true, expectedVersion: "2" },
      apps: { available: false },
      artifacts: { available: true },
    })
    renderShell()

    const nav = screen.getByRole("navigation", { name: "Main navigation" })
    expect(await within(nav).findByTestId("nav-artifacts")).toHaveAttribute(
      "href",
      "/artifacts",
    )
  })

  it("hides the entry when artifact storage is not configured", async () => {
    stubViewport(true)
    mocks.info.mockResolvedValue({
      code: { configured: true, expectedVersion: "2" },
      apps: { available: false },
      artifacts: { available: false },
    })
    renderShell(<AvailabilityProbe />)

    await waitFor(() =>
      expect(screen.getByTestId("artifacts-availability")).toHaveTextContent("false"),
    )
    expect(screen.getByTestId("nav-search")).toBeInTheDocument()
    expect(screen.queryByTestId("nav-artifacts")).toBeNull()
  })
})

describe("sidebar apps entry", () => {
  it("links to /apps when the host reports an app surface", async () => {
    stubViewport(true)
    mocks.info.mockResolvedValue({
      code: { configured: true, expectedVersion: "2" },
      apps: { available: true },
    })
    renderShell()

    const nav = screen.getByRole("navigation", { name: "Main navigation" })
    expect(await within(nav).findByTestId("nav-apps")).toHaveAttribute("href", "/apps")
  })

  it("hides the entry when the host has no app surface", async () => {
    stubViewport(true)
    mocks.info.mockResolvedValue({
      code: { configured: true, expectedVersion: "2" },
      apps: { available: false },
    })
    renderShell(<AvailabilityProbe />)

    // Wait for the info-driven state itself; only a settled answer makes
    // "the entry is still absent" meaningful.
    await waitFor(() =>
      expect(screen.getByTestId("apps-availability")).toHaveTextContent("false"),
    )
    expect(screen.getByTestId("nav-search")).toBeInTheDocument()
    expect(screen.queryByTestId("nav-apps")).toBeNull()
  })
})

describe("sidebar worktrees entry", () => {
  it("links to /worktrees on the desktop sidebar when Code is configured", async () => {
    stubViewport(true)
    renderShell()

    const nav = screen.getByRole("navigation", { name: "Main navigation" })
    expect(await within(nav).findByTestId("nav-worktrees")).toHaveAttribute("href", "/worktrees")
  })

  it("hides the entry when the Code surface is not configured", async () => {
    stubViewport(true)
    mocks.info.mockResolvedValue({
      code: { configured: false, expectedVersion: "2" },
      apps: { available: true },
      artifacts: { available: true },
    })
    renderShell(<AvailabilityProbe />)

    // Wait for the info-driven state itself; only a settled answer makes
    // "the entry is still absent" meaningful.
    await waitFor(() =>
      expect(screen.getByTestId("code-availability")).toHaveTextContent("false"),
    )
    expect(screen.getByTestId("nav-search")).toBeInTheDocument()
    expect(screen.queryByTestId("nav-worktrees")).toBeNull()
  })

  it("navigates to the worktree page from the sidebar", async () => {
    const user = userEvent.setup()
    stubViewport(true)
    renderShell()

    const nav = screen.getByRole("navigation", { name: "Main navigation" })
    await user.click(await within(nav).findByTestId("nav-worktrees"))

    expect(await screen.findByText("worktrees page")).toBeInTheDocument()
  })
})
