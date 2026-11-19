import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { MemoryRouter, Route, Routes, Link, useLocation } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CodeRoute } from "../src/App"
import { SessionSidebar } from "../src/chat/SessionSidebar"
import { SurfaceHome, SurfaceProvider } from "../src/code/SurfaceProvider"
import { SurfaceSwitch } from "../src/code/SurfaceSwitch"
import {
  SURFACE_STORAGE_KEY,
  codeDeepLink,
  readSurface,
  surfaceForPath,
  writeSurface,
} from "../src/code/surface"
import { AppShell } from "../src/components/AppShell"
import { I18nProvider } from "../src/i18n/provider"
import { ThemeProvider } from "../src/theme/provider"

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  codeTicket: vi.fn(),
  codeStatus: vi.fn(),
}))

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
    sessions: [{ id: "ses_1", title: "Alpha", directory: "/work", created: 0, updated: 0 }],
    loading: false,
    failed: false,
    refresh: vi.fn(),
    create: vi.fn(),
  }),
}))

beforeEach(() => {
  // jsdom keeps one localStorage per file: the restore/persistence tests below
  // write "code", and a later mount at "/" would then redirect to /code in the
  // same tick the chord test presses the key, so the two toggle each other.
  window.localStorage.clear()
  mocks.info.mockReset()
  mocks.codeTicket.mockReset()
  mocks.codeStatus.mockReset()
  mocks.info.mockResolvedValue({ code: { configured: true, expectedVersion: "2" } })
  mocks.codeTicket.mockImplementation(
    async () => ({ url: "https://code.example.com/__auth?ticket=test&next=%2F" }),
  )
  mocks.codeStatus.mockResolvedValue({
    configured: true,
    reachable: true,
    version: "2.3.0",
    expectedVersion: "2",
    matches: true,
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/**
 * The desktop layout. Below `lg` the switch lives in the app-bar menu, so a
 * test about the bar's own switch has to ask for the wide layout explicitly.
 */
function stubWideViewport() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width: 1024px"),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  }
}

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>
}

function providers(entry: string, children: ReactNode) {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale="en">
        <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter>
      </I18nProvider>
    </ThemeProvider>,
  )
}

function renderSwitch(entry = "/") {
  return providers(
    entry,
    <SurfaceProvider>
      <LocationProbe />
      <SurfaceSwitch />
      <Routes>
        <Route
          path="/"
          element={
            <SurfaceHome>
              <p>chat home</p>
            </SurfaceHome>
          }
        />
        <Route path="/code" element={<p>code home</p>} />
        <Route path="/code/*" element={<p>code home</p>} />
      </Routes>
    </SurfaceProvider>,
  )
}

function renderShell(entry: string) {
  return providers(
    entry,
    <SurfaceProvider>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<p>chat home</p>} />
          <Route path="/code" element={<CodeRoute />} />
          <Route path="/code/*" element={<CodeRoute />} />
        </Route>
      </Routes>
    </SurfaceProvider>,
  )
}

describe("surface switch", () => {
  it("renders Chat | Code and follows the route with aria-pressed", async () => {
    const user = userEvent.setup()
    renderSwitch("/")

    await waitFor(() => expect(screen.getByTestId("surface-switch")).toBeInTheDocument())
    expect(screen.getByTestId("surface-chat")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("surface-code")).toHaveAttribute("aria-pressed", "false")

    await user.click(screen.getByTestId("surface-code"))
    expect(screen.getByTestId("location")).toHaveTextContent("/code")
    expect(screen.getByTestId("surface-code")).toHaveAttribute("aria-pressed", "true")
    expect(window.localStorage.getItem(SURFACE_STORAGE_KEY)).toBe("code")

    await user.click(screen.getByTestId("surface-chat"))
    expect(screen.getByTestId("location")).toHaveTextContent("/")
    expect(screen.getByTestId("surface-chat")).toHaveAttribute("aria-pressed", "true")
    expect(window.localStorage.getItem(SURFACE_STORAGE_KEY)).toBe("chat")
  })

  it("restores Code from localStorage when the app opens at /", async () => {
    window.localStorage.setItem(SURFACE_STORAGE_KEY, "code")
    renderSwitch("/")

    expect(await screen.findByText("code home")).toBeInTheDocument()
    expect(screen.getByTestId("location")).toHaveTextContent("/code")
  })

  it("keeps a client-side visit to / in chat instead of restoring Code", async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(SURFACE_STORAGE_KEY, "code")
    providers(
      "/code",
      <SurfaceProvider>
        <LocationProbe />
        <Link to="/">to chat</Link>
        <Routes>
          <Route
            path="/"
            element={
              <SurfaceHome>
                <p>chat home</p>
              </SurfaceHome>
            }
          />
          <Route path="/code/*" element={<p>code home</p>} />
        </Routes>
      </SurfaceProvider>,
    )

    expect(await screen.findByText("code home")).toBeInTheDocument()
    await user.click(screen.getByRole("link", { name: "to chat" }))

    expect(await screen.findByText("chat home")).toBeInTheDocument()
    expect(screen.getByTestId("location")).toHaveTextContent("/")
  })

  it("toggles with Cmd/Ctrl+Shift+M and ignores other key shapes", async () => {
    renderSwitch("/")
    await waitFor(() => expect(screen.getByTestId("surface-switch")).toBeInTheDocument())

    fireEvent.keyDown(window, { key: "m", metaKey: true, shiftKey: true })
    // The chord listener attaches in an effect once the host status resolves;
    // waiting for the switch element alone races that effect under a loaded
    // runner (CI), so the navigation is awaited instead of assumed.
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/code"))

    fireEvent.keyDown(window, { key: "m", shiftKey: true })
    fireEvent.keyDown(window, { key: "m", metaKey: true })
    fireEvent.keyDown(window, { key: "Escape", metaKey: true, shiftKey: true })
    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true })
    fireEvent.keyDown(window, { key: "m", metaKey: true, shiftKey: true, altKey: true })
    // The old chord belongs to new chat (spec 09) and must not toggle.
    fireEvent.keyDown(window, { key: "o", metaKey: true, shiftKey: true })
    expect(screen.getByTestId("location")).toHaveTextContent("/code")

    fireEvent.keyDown(window, { key: "m", ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/))
  })

  it("stays hidden and inert when the deployment has no Code host", async () => {
    mocks.info.mockResolvedValue({ code: { configured: false, expectedVersion: "2" } })
    renderSwitch("/")

    await waitFor(() => expect(mocks.info).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByText("chat home")).toBeInTheDocument())
    expect(screen.queryByTestId("surface-switch")).toBeNull()

    fireEvent.keyDown(window, { key: "m", metaKey: true, shiftKey: true })
    expect(screen.getByTestId("location")).toHaveTextContent("/")
  })
})

describe("surface layout", () => {
  it("keeps the switch in the app bar and hides the chat sidebar on /code", async () => {
    stubWideViewport()
    const chat = renderShell("/")
    expect(await screen.findByTestId("app-bar")).toBeInTheDocument()
    expect(screen.getByTestId("app-bar")).toHaveAttribute("role", "banner")
    expect(screen.getByTestId("app-drawer")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId("surface-switch")).toBeInTheDocument())
    chat.unmount()

    renderShell("/code/workspace/x")
    expect(await screen.findByTestId("code-bar")).toBeInTheDocument()
    expect(screen.queryByTestId("app-bar")).toBeNull()
    expect(screen.queryByTestId("app-drawer")).toBeNull()
    // The Code page's own bar carries the one switch on this surface.
    expect(screen.getByTestId("surface-switch")).toBeInTheDocument()
    expect(screen.getAllByTestId("surface-switch")).toHaveLength(1)
  })

  it("follows a chat sidebar navigation back to the Chat surface", async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(SURFACE_STORAGE_KEY, "code")
    providers(
      "/code",
      <SurfaceProvider>
        <LocationProbe />
        <SurfaceSwitch />
        <SessionSidebar />
        <Routes>
          <Route path="/c/:sessionId" element={<p>chat target</p>} />
          <Route path="/code/*" element={<p>code home</p>} />
        </Routes>
      </SurfaceProvider>,
    )

    await user.click(await screen.findByTestId("session-item"))

    expect(await screen.findByText("chat target")).toBeInTheDocument()
    expect(screen.getByTestId("surface-chat")).toHaveAttribute("aria-pressed", "true")
    expect(window.localStorage.getItem(SURFACE_STORAGE_KEY)).toBe("chat")
  })
})

describe("surface helpers", () => {
  it("maps routes to their surface", () => {
    expect(surfaceForPath("/code")).toBe("code")
    expect(surfaceForPath("/code/workspace/x")).toBe("code")
    expect(surfaceForPath("/")).toBe("chat")
    expect(surfaceForPath("/c/ses_1")).toBe("chat")
    expect(surfaceForPath("/search")).toBe("chat")
    expect(surfaceForPath("/coder")).toBe("chat")
  })

  it("defaults to chat and rejects a malformed stored value", () => {
    const storage = memoryStorage()
    expect(readSurface(storage)).toBe("chat")
    writeSurface("code", storage)
    expect(readSurface(storage)).toBe("code")
    storage.setItem(SURFACE_STORAGE_KEY, "work")
    expect(readSurface(storage)).toBe("chat")
  })

  it("survives a storage partition that throws", () => {
    const denied = {
      getItem: () => {
        throw new Error("denied")
      },
      setItem: () => {
        throw new Error("denied")
      },
      removeItem: () => {
        throw new Error("denied")
      },
    } as unknown as Storage
    expect(readSurface(denied)).toBe("chat")
    expect(() => writeSurface("code", denied)).not.toThrow()
  })

  it("maps app paths to Code-host next paths", () => {
    expect(codeDeepLink("/code")).toBe("/")
    expect(codeDeepLink("/code/")).toBe("/")
    expect(codeDeepLink("/code/workspace/x")).toBe("/workspace/x")
    expect(codeDeepLink("/code//x")).toBe("/x")
    expect(codeDeepLink("/coder")).toBe("/")
  })
})
