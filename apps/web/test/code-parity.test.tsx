import userEvent from "@testing-library/user-event"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { CodeRoute } from "../src/App"
import { CODE_STATUS_POLL_MS } from "../src/code/CodePage"
import { SurfaceProvider } from "../src/code/SurfaceProvider"
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
    sessions: [],
    loading: false,
    failed: false,
    refresh: vi.fn(),
    create: vi.fn(),
  }),
}))

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

function renderShell(entry: string) {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale="en">
        <MemoryRouter initialEntries={[entry]}>
          <SurfaceProvider>
            <Routes>
              <Route element={<AppShell />}>
                <Route path="/" element={<p>chat home</p>} />
                <Route path="/code" element={<CodeRoute />} />
                <Route path="/code/*" element={<CodeRoute />} />
              </Route>
            </Routes>
          </SurfaceProvider>
        </MemoryRouter>
      </I18nProvider>
    </ThemeProvider>,
  )
}

beforeEach(() => {
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

describe("code frame parity", () => {
  /**
   * Switching surfaces must keep the live frame: a remount would drop an
   * unsent prompt inside the Code UI and start a fresh host session. The only
   * proof the app can give is element identity plus an unchanged `src`.
   */
  it("reuses the same frame and ticket across Chat → Code → Chat", async () => {
    const user = userEvent.setup()
    stubWideViewport()
    renderShell("/")

    await user.click(await screen.findByTestId("surface-code"))
    const frame = await screen.findByTestId("code-frame")
    const src = frame.getAttribute("src")
    const tickets = mocks.codeTicket.mock.calls.length
    expect(tickets).toBeGreaterThan(0)

    await user.click(screen.getByTestId("surface-chat"))
    await waitFor(() =>
      expect(screen.getByTestId("code-surface")).toHaveAttribute("hidden"),
    )
    // Hidden means hidden: no bar, no switch, no banner, and the iframe is out
    // of the tab order on top of the inert subtree.
    expect(screen.queryByTestId("code-bar")).toBeNull()
    expect(screen.getAllByTestId("surface-switch")).toHaveLength(1)
    expect(screen.getByTestId("code-surface")).toHaveAttribute("inert")
    expect(screen.getByTestId("code-surface")).toHaveAttribute("aria-hidden", "true")
    expect(screen.getByTestId("code-frame")).toHaveAttribute("tabindex", "-1")
    expect(screen.getByTestId("code-frame")).toBe(frame)

    await user.click(screen.getByTestId("surface-code"))
    const again = await screen.findByTestId("code-frame")
    expect(again).toBe(frame)
    expect(again).toHaveAttribute("src", src ?? "")
    expect(mocks.codeTicket.mock.calls.length).toBe(tickets)
  })

  it("pauses the status poll while hidden and refreshes once on return", async () => {
    vi.useFakeTimers()
    stubWideViewport()
    renderShell("/")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    fireEvent.click(screen.getByTestId("surface-code"))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByTestId("code-frame")).toBeInTheDocument()
    const atOpen = mocks.codeStatus.mock.calls.length

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CODE_STATUS_POLL_MS)
    })
    expect(mocks.codeStatus.mock.calls.length).toBe(atOpen + 1)

    fireEvent.click(screen.getByTestId("surface-chat"))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const atHide = mocks.codeStatus.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CODE_STATUS_POLL_MS * 3)
    })
    expect(mocks.codeStatus.mock.calls.length).toBe(atHide)

    fireEvent.click(screen.getByTestId("surface-code"))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mocks.codeStatus.mock.calls.length).toBe(atHide + 1)
  })

  it("recovers from an unreachable Code host without a manual retry", async () => {
    vi.useFakeTimers()
    stubWideViewport()
    mocks.codeStatus
      .mockResolvedValueOnce({
        configured: true,
        reachable: false,
        expectedVersion: "2",
        matches: false,
      })
      .mockResolvedValue({
        configured: true,
        reachable: true,
        version: "2.3.0",
        expectedVersion: "2",
        matches: true,
      })
    renderShell("/")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    fireEvent.click(screen.getByTestId("surface-code"))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByText("The health probe got no answer from the Code host.")).toBeInTheDocument()
    expect(screen.queryByTestId("code-frame")).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CODE_STATUS_POLL_MS)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByTestId("code-frame")).toBeInTheDocument()
  })
})

