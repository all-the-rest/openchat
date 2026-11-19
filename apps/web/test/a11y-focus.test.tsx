import type { PermissionRequest } from "@openchat/contracts"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useEffect, useState, type ReactNode } from "react"
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PermissionCard } from "../src/chat/PermissionCard"
import type { PermissionValue } from "../src/chat/permissions"
import { SurfaceProvider } from "../src/code/SurfaceProvider"
import { AppShell } from "../src/components/AppShell"
import { I18nProvider } from "../src/i18n/provider"
import { useReportPaletteChat } from "../src/palette/current-chat"
import { ThemeProvider } from "../src/theme/provider"

const mocks = vi.hoisted(() => ({ info: vi.fn(), create: vi.fn(), search: vi.fn() }))

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

function ChatProbe() {
  const { sessionId = "" } = useParams()
  useReportPaletteChat({ sessionID: sessionId, title: "Chat", lastAnswer: null })
  return <p>chat page</p>
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
                <Route
                  index
                  element={
                    <>
                      <input data-testid="typing-field" aria-label="typing field" />
                      <p>home</p>
                    </>
                  }
                />
                <Route path="/c/:sessionId" element={<ChatProbe />} />
              </Route>
            </Routes>
          </SurfaceProvider>
        </MemoryRouter>
      </I18nProvider>
    </ThemeProvider>,
  )
}

beforeEach(() => {
  mocks.create.mockResolvedValue({ id: "ses_new" })
  mocks.info.mockResolvedValue({
    code: { configured: true, expectedVersion: "2.3.0" },
    apps: { available: true },
    artifacts: { available: true },
  })
  mocks.search.mockResolvedValue({ query: "", available: [], groups: [] })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe("focus order", () => {
  it("lands on the skip link on the first Tab", async () => {
    const user = userEvent.setup()
    renderShell()

    await user.tab()
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveFocus()
  })

  it("opens the palette while the menu is open and restores focus only to the menu trigger", async () => {
    stubViewport(false)
    const user = userEvent.setup()
    renderShell()

    const menuTrigger = screen.getByTestId("app-bar-menu")
    await user.click(menuTrigger)
    const menu = screen.getByRole("menu")
    expect(within(menu).getByTestId("menu-search")).toHaveFocus()

    fireEvent.keyDown(window, { key: "k", ctrlKey: true })
    const dialog = await screen.findByRole("dialog", { name: "Command palette" })
    const input = screen.getByTestId("palette-input")
    await waitFor(() => expect(input).toHaveFocus())

    fireEvent.keyDown(input, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())

    // Both overlays close and focus settles on exactly one element: the menu
    // trigger. The palette's opener (a now-unmounted menu item) never wins.
    expect(menuTrigger).toHaveFocus()
  })
})

const request: PermissionRequest = {
  id: "per_1",
  sessionID: "ses_1",
  tool: "bash",
  action: "Run pnpm test",
  resources: ["pnpm test"],
}

function PermissionHarness({ reply }: { reply: PermissionValue["reply"] }) {
  const [shown, setShown] = useState(false)
  // Mirrors the real chat: after a decision the request leaves the value, the
  // card unmounts and the previously disabled composer re-enables.
  const decide: PermissionValue["reply"] = async (requestID, decision) => {
    const result = await reply(requestID, decision)
    setShown(false)
    return result
  }
  const value: PermissionValue = {
    requests: shown ? [request] : [],
    pending: shown,
    busy: false,
    failure: false,
    reply: decide,
  }
  return (
    <>
      <button
        type="button"
        data-testid="focus-before"
        onClick={() => {
          // Simulate the real browser: enabling `permission.pending` disables the
          // composer, which blurs the focused control to <body> during commit —
          // before the card's effect runs. The focus tracker must already have
          // captured the trigger via `focusin`.
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
          setShown(true)
        }}
      >
        Open
      </button>
      <PermissionCard value={value} />
    </>
  )
}

function withI18n(children: ReactNode) {
  return <I18nProvider initialLocale="en">{children}</I18nProvider>
}

describe("permission card", () => {
  it("is an alertdialog that takes focus on mount and restores it on a decision", async () => {
    const user = userEvent.setup()
    const reply = vi.fn(async () => true)
    render(withI18n(<PermissionHarness reply={reply} />))

    const trigger = screen.getByTestId("focus-before")
    await user.click(trigger)

    const card = screen.getByTestId("permission-card")
    expect(card).toHaveAttribute("role", "alertdialog")
    const labelID = card.getAttribute("aria-labelledby")
    const descriptionID = card.getAttribute("aria-describedby")
    expect(labelID).toBeTruthy()
    expect(descriptionID).toBeTruthy()
    expect(screen.getByText("Permission required")).toHaveAttribute("id", labelID!)
    expect(screen.getByText("Run pnpm test")).toHaveAttribute("id", descriptionID!)
    expect(card).toHaveFocus()

    await user.click(screen.getByTestId("permission-allow-once"))
    expect(reply).toHaveBeenCalledWith("per_1", "once")
    // Restore happens after the request settles and the control re-enables.
    await waitFor(() => expect(trigger).toHaveFocus())
  })
})

describe("keyboard map", () => {
  it("starts a new chat on Shift+N", async () => {
    renderShell()

    fireEvent.keyDown(window, { key: "N", shiftKey: true })
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/c/ses_new"))
    expect(mocks.create).toHaveBeenCalledTimes(1)
  })

  it("does not start a chat when a capital N is typed in a field", () => {
    renderShell()

    const field = screen.getByTestId("typing-field")
    field.focus()
    fireEvent.keyDown(field, { key: "N", shiftKey: true })
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it("opens the shortcuts help on Ctrl+/ and restores focus to the opener on Escape", async () => {
    renderShell()

    // Focus a control in the app shell before opening; the help tracks it via
    // `focusin` and restores it on close even though the shell goes inert.
    const opener = screen.getByTestId("palette-open")
    opener.focus()

    fireEvent.keyDown(window, { key: "/", ctrlKey: true })
    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" })
    expect(screen.getByTestId("shortcuts-help-close")).toHaveFocus()
    expect(within(dialog).getByText("Ctrl/Cmd + K")).toBeInTheDocument()
    expect(within(dialog).getByText("Shift + N")).toBeInTheDocument()

    fireEvent.keyDown(dialog, { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("shortcuts-help")).toBeNull())
    await waitFor(() => expect(opener).toHaveFocus())
  })
})
