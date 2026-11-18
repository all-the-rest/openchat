import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SurfaceProvider } from "../src/code/SurfaceProvider"
import { SURFACE_STORAGE_KEY } from "../src/code/surface"
import { AppShell } from "../src/components/AppShell"
import { I18nProvider } from "../src/i18n/provider"
import { ThemeProvider } from "../src/theme/provider"

const mocks = vi.hoisted(() => ({ info: vi.fn(), create: vi.fn() }))

vi.mock("../src/api/client", () => ({ api: mocks }))

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
    create: mocks.create,
  }),
}))

beforeEach(() => {
  mocks.create.mockResolvedValue({ id: "ses_new" })
  mocks.info.mockResolvedValue({
    code: { configured: true, expectedVersion: "2.3.0" },
    apps: { available: true },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

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

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>
}

function renderShell() {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale="en">
        <MemoryRouter initialEntries={["/"]}>
          <SurfaceProvider>
            <LocationProbe />
            <Routes>
              <Route element={<AppShell />}>
                <Route index element={<p>chat home</p>} />
                <Route path="/search" element={<p>search page</p>} />
                <Route path="/apps" element={<p>apps page</p>} />
                <Route path="/artifacts" element={<p>artifacts page</p>} />
                <Route path="/c/:sessionId" element={<p>chat page</p>} />
                <Route path="/code" element={<p>code page</p>} />
              </Route>
            </Routes>
          </SurfaceProvider>
        </MemoryRouter>
      </I18nProvider>
    </ThemeProvider>,
  )
}

function trigger() {
  return screen.getByTestId("app-bar-menu")
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(trigger())
  return screen.getByRole("menu")
}

describe("app bar menu breakpoint", () => {
  it("renders only below the wide breakpoint", () => {
    stubViewport(true)
    const wide = renderShell()
    expect(screen.queryByTestId("app-bar-menu")).toBeNull()
    wide.unmount()

    stubViewport(false)
    renderShell()
    expect(trigger()).toBeInTheDocument()
  })

  it("keeps the inline switch on wide layouts and moves it into the menu below", async () => {
    stubViewport(true)
    const wide = renderShell()
    expect(await screen.findByTestId("surface-switch")).toBeInTheDocument()
    expect(wide.container.querySelector('[data-testid="app-bar-menu"]')).toBeNull()
    wide.unmount()

    stubViewport(false)
    renderShell()
    // Below `lg` the switch exists exactly once, inside the open menu.
    expect(screen.queryByTestId("surface-switch")).toBeNull()
    const user = userEvent.setup()
    const menu = await openMenu(user)
    expect(within(menu).getByTestId("surface-switch")).toBeInTheDocument()
  })
})

describe("app bar menu behaviour", () => {
  it("opens on click, flips aria-expanded and exposes the menu items", async () => {
    stubViewport(false)
    const user = userEvent.setup()
    renderShell()

    const button = trigger()
    expect(button).toHaveAttribute("aria-haspopup", "menu")
    expect(button).toHaveAttribute("aria-expanded", "false")

    const menu = await openMenu(user)
    expect(button).toHaveAttribute("aria-expanded", "true")
    expect(button).toHaveAttribute("aria-controls", menu.id)
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(4)
    expect(within(menu).getByRole("group", { name: "Surface" })).toBeInTheDocument()
    // The menu carries navigation, never the session list.
    expect(within(menu).queryByTestId("session-item")).toBeNull()
  })

  it("closes on Escape and returns focus to the trigger", async () => {
    stubViewport(false)
    const user = userEvent.setup()
    renderShell()

    const button = trigger()
    await openMenu(user)
    expect(screen.getByTestId("menu-search")).toHaveFocus()

    await user.keyboard("{Escape}")

    expect(screen.queryByRole("menu")).toBeNull()
    expect(button).toHaveAttribute("aria-expanded", "false")
    expect(button).toHaveFocus()
  })

  it("closes on a pointer-down outside the menu", async () => {
    stubViewport(false)
    const user = userEvent.setup()
    renderShell()

    await openMenu(user)
    fireEvent.pointerDown(document.body)

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    expect(trigger()).toHaveAttribute("aria-expanded", "false")
  })

  it("is not a focus trap: Tab leaves the menu", async () => {
    stubViewport(false)
    const user = userEvent.setup()
    renderShell()

    await openMenu(user)
    screen.getByTestId("menu-new-chat").focus()
    await user.tab()

    const menu = screen.queryByRole("menu")
    expect(menu).not.toBeNull()
    expect(menu?.contains(document.activeElement)).toBe(false)
  })

  it("moves with ArrowUp/ArrowDown and Home/End between items", async () => {
    stubViewport(false)
    const user = userEvent.setup()
    renderShell()

    const button = trigger()
    await waitFor(() => expect(mocks.info).toHaveBeenCalledTimes(1))
    // Let the provider store `apps.available` before the menu enumerates items.
    await new Promise((resolve) => setTimeout(resolve, 20))

    fireEvent.keyDown(button, { key: "ArrowDown" })
    const items = [
      screen.getByTestId("menu-search"),
      screen.getByTestId("menu-apps"),
      screen.getByTestId("menu-settings"),
      screen.getByTestId("menu-new-chat"),
    ]
    expect(items[0]).toHaveFocus()

    fireEvent.keyDown(items[0]!, { key: "ArrowDown" })
    expect(items[1]).toHaveFocus()
    fireEvent.keyDown(items[1]!, { key: "ArrowDown" })
    expect(items[2]).toHaveFocus()
    fireEvent.keyDown(items[2]!, { key: "ArrowDown" })
    expect(items[3]).toHaveFocus()
    fireEvent.keyDown(items[3]!, { key: "ArrowDown" })
    expect(items[0]).toHaveFocus()

    fireEvent.keyDown(items[0]!, { key: "ArrowUp" })
    expect(items[3]).toHaveFocus()

    fireEvent.keyDown(items[3]!, { key: "Home" })
    expect(items[0]).toHaveFocus()
    fireEvent.keyDown(items[0]!, { key: "End" })
    expect(items[3]).toHaveFocus()
  })
})

describe("app bar menu entries", () => {
  it("switches the surface through the menu and closes", async () => {
    stubViewport(false)
    const user = userEvent.setup()
    renderShell()

    const menu = await openMenu(user)
    await user.click(within(menu).getByTestId("surface-code"))

    expect(screen.getByTestId("location")).toHaveTextContent("/code")
    expect(window.localStorage.getItem(SURFACE_STORAGE_KEY)).toBe("code")
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("hides the surface entry when no Code host is configured", async () => {
    stubViewport(false)
    mocks.info.mockResolvedValue({
      code: { configured: false, expectedVersion: "2.3.0" },
      apps: { available: true },
    })
    const user = userEvent.setup()
    renderShell()

    await waitFor(() => expect(mocks.info).toHaveBeenCalled())
    const menu = await openMenu(user)

    expect(within(menu).queryByTestId("surface-switch")).toBeNull()
    expect(within(menu).getByTestId("menu-search")).toBeInTheDocument()
  })

  it("navigates to Search and Apps and closes after each", async () => {
    stubViewport(false)
    const user = userEvent.setup()
    renderShell()

    let menu = await openMenu(user)
    await user.click(within(menu).getByTestId("menu-apps"))
    expect(screen.getByTestId("location")).toHaveTextContent("/apps")
    expect(screen.queryByRole("menu")).toBeNull()

    menu = await openMenu(user)
    await user.click(within(menu).getByTestId("menu-search"))
    expect(screen.getByTestId("location")).toHaveTextContent("/search?scope=all")
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("hides the Apps entry when the host has no app surface", async () => {
    stubViewport(false)
    mocks.info.mockResolvedValue({
      code: { configured: true, expectedVersion: "2.3.0" },
      apps: { available: false },
    })
    const user = userEvent.setup()
    renderShell()

    await waitFor(() => expect(mocks.info).toHaveBeenCalled())
    const menu = await openMenu(user)

    expect(within(menu).queryByTestId("menu-apps")).toBeNull()
    expect(within(menu).getByTestId("menu-search")).toBeInTheDocument()
    expect(within(menu).getByTestId("menu-new-chat")).toBeInTheDocument()
  })

  it("opens the artifact list and closes the menu", async () => {
    stubViewport(false)
    mocks.info.mockResolvedValue({
      code: { configured: true, expectedVersion: "2.3.0" },
      apps: { available: true },
      artifacts: { available: true },
    })
    const user = userEvent.setup()
    renderShell()

    const menu = await openMenu(user)
    await user.click(within(menu).getByTestId("menu-artifacts"))
    expect(screen.getByTestId("location")).toHaveTextContent("/artifacts")
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("hides the Artifacts entry when storage is not configured", async () => {
    stubViewport(false)
    const user = userEvent.setup()
    renderShell()

    await waitFor(() => expect(mocks.info).toHaveBeenCalled())
    const menu = await openMenu(user)

    expect(within(menu).queryByTestId("menu-artifacts")).toBeNull()
  })

  it("creates a chat like the sidebar's New chat and closes", async () => {
    stubViewport(false)
    const user = userEvent.setup()
    renderShell()

    const menu = await openMenu(user)
    await user.click(within(menu).getByTestId("menu-new-chat"))

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/c/ses_new"))
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("menu")).toBeNull()
  })
})
