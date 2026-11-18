import type { CodeStatusResponse } from "@openchat/contracts"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CodeRoute } from "../src/App"
import { CodePage } from "../src/code/CodePage"
import { SurfaceProvider } from "../src/code/SurfaceProvider"
import { I18nProvider } from "../src/i18n/provider"
import { ThemeProvider } from "../src/theme/provider"

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  codeTicket: vi.fn(),
  codeStatus: vi.fn(),
}))

vi.mock("../src/api/client", () => ({ api: mocks }))

const CODE_ORIGIN = "https://code.example.com"

function status(overrides: Partial<CodeStatusResponse> = {}): CodeStatusResponse {
  return {
    configured: true,
    reachable: true,
    version: "2.3.0",
    expectedVersion: "2.3.0",
    matches: true,
    ...overrides,
  }
}

/** Stubs the viewport: only the wide layout matches the desktop query. */
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

let tickets = 0

beforeEach(() => {
  tickets = 0
  stubViewport(true)
  mocks.info.mockResolvedValue({ code: { configured: true, expectedVersion: "2.3.0" } })
  mocks.codeStatus.mockResolvedValue(status())
  mocks.codeTicket.mockImplementation(async () => {
    tickets += 1
    return { url: `${CODE_ORIGIN}/__auth?ticket=t${tickets}&next=%2F` }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true })
})

function providers(entry: string, children: ReactNode) {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale="en">
        <MemoryRouter initialEntries={[entry]}>
          <SurfaceProvider>{children}</SurfaceProvider>
        </MemoryRouter>
      </I18nProvider>
    </ThemeProvider>,
  )
}

function renderCode(entry = "/code", props: { loadTimeoutMs?: number } = {}) {
  return providers(
    entry,
    <Routes>
      <Route path="/code" element={<CodePage {...props} />} />
      <Route path="/code/*" element={<CodePage {...props} />} />
      <Route path="/" element={<p>chat home</p>} />
    </Routes>,
  )
}

function unauthenticated(origin: string, data: unknown = { state: "unauthenticated" }) {
  return new MessageEvent("message", {
    origin,
    data: { type: "openchat:code-state", ...(data as object) },
  })
}

describe("Code page", () => {
  it("mints a ticket for the deep-link suffix and uses it as the frame source", async () => {
    renderCode("/code/workspace/x")

    await waitFor(() => expect(mocks.codeTicket).toHaveBeenCalled())
    expect(mocks.codeTicket.mock.calls[0]?.[0]).toBe("/workspace/x")

    const frame = await screen.findByTestId("code-frame")
    expect(frame).toHaveAttribute("src", `${CODE_ORIGIN}/__auth?ticket=t1&next=%2F`)
    expect(frame).toHaveAttribute("title", "OpenCode workspace")
    expect(frame).toHaveAttribute("allow", "clipboard-read; clipboard-write")
    expect(screen.getByTestId("code-new-tab")).toHaveTextContent("Open Code in a new tab")

    // The new tab gets its own single-use ticket.
    expect(screen.getByTestId("code-new-tab")).toHaveAttribute(
      "href",
      `${CODE_ORIGIN}/__auth?ticket=t2&next=%2F`,
    )
  })

  it("passes the root path for bare /code", async () => {
    renderCode("/code")
    await waitFor(() => expect(mocks.codeTicket).toHaveBeenCalled())
    expect(mocks.codeTicket.mock.calls[0]?.[0]).toBe("/")
  })

  it("shows loading in the bar, keeps the frame area and clears on load", async () => {
    let resolve!: (value: { url: string }) => void
    const pending = new Promise<{ url: string }>((done) => {
      resolve = done
    })
    mocks.codeTicket.mockReturnValueOnce(pending)

    renderCode()
    expect(await screen.findByTestId("code-state")).toHaveTextContent("Loading…")
    expect(screen.getByTestId("code-frame-area")).toBeInTheDocument()
    expect(screen.queryByTestId("code-frame")).toBeNull()

    await act(async () => resolve({ url: `${CODE_ORIGIN}/__auth?ticket=slow` }))
    const frame = await screen.findByTestId("code-frame")
    expect(screen.getByTestId("code-state")).toHaveTextContent("Loading…")

    fireEvent.load(frame)
    await waitFor(() => expect(screen.getByTestId("code-state")).toHaveTextContent("Connected"))
  })

  it("reports a failed ticket as its own error without the expected version", async () => {
    const user = userEvent.setup()
    mocks.codeTicket.mockRejectedValueOnce(new Error("throttled"))

    renderCode()
    expect(await screen.findByText("No Code sign-in ticket")).toBeInTheDocument()
    expect(
      screen.getByText(
        "The app could not create a sign-in ticket. The ticket limit may be exhausted; wait a minute and try again.",
      ),
    ).toBeInTheDocument()
    // The Code host itself is not the failure here, so no version line.
    expect(screen.queryByText("This app expects version 2.3.0.")).toBeNull()
    expect(screen.queryByTestId("code-frame")).toBeNull()
    expect(screen.getByTestId("code-state")).toHaveTextContent("Not reachable")

    await user.click(screen.getByRole("button", { name: "Retry" }))
    expect(await screen.findByTestId("code-frame")).toBeInTheDocument()
  })

  it("reports an unreachable Code host with the expected version", async () => {
    mocks.codeStatus.mockResolvedValue(
      status({ reachable: false, version: undefined, matches: false }),
    )

    renderCode()
    expect(
      await screen.findByText("The health probe got no answer from the Code host."),
    ).toBeInTheDocument()
    expect(screen.getByText("This app expects version 2.3.0.")).toBeInTheDocument()
    expect(screen.queryByTestId("code-frame")).toBeNull()
  })

  it("warns on a version mismatch without blocking the frame", async () => {
    mocks.codeStatus.mockResolvedValue(status({ version: "2.4.0", matches: false }))

    renderCode()
    expect(await screen.findByTestId("code-version-warning")).toHaveTextContent(
      "The Code host reports version 2.4.0; this app expects 2.3.0.",
    )
    expect(await screen.findByTestId("code-frame")).toBeInTheDocument()
  })

  it("accepts the unauthenticated state only from the Code host origin", async () => {
    const user = userEvent.setup()
    renderCode()
    const frame = await screen.findByTestId("code-frame")
    fireEvent.load(frame)

    await act(async () => {
      window.dispatchEvent(unauthenticated("https://evil.test"))
    })
    expect(screen.queryByText("Sign in to open Code")).toBeNull()
    expect(screen.getByTestId("code-frame")).toBeInTheDocument()

    await act(async () => {
      window.dispatchEvent(unauthenticated(CODE_ORIGIN, { state: "ready" }))
    })
    expect(screen.queryByText("Sign in to open Code")).toBeNull()

    const before = mocks.codeTicket.mock.calls.length
    await act(async () => {
      window.dispatchEvent(unauthenticated(CODE_ORIGIN))
    })
    expect(await screen.findByText("Sign in to open Code")).toBeInTheDocument()

    await user.click(screen.getByTestId("code-sign-in"))
    await waitFor(() => expect(mocks.codeTicket.mock.calls.length).toBeGreaterThan(before))
    expect(await screen.findByTestId("code-frame")).toBeInTheDocument()
  })

  it("falls back when the frame never loads", async () => {
    renderCode("/code", { loadTimeoutMs: 20 })
    expect(await screen.findByTestId("code-frame")).toBeInTheDocument()

    expect(
      await screen.findByText("The Code interface could not be embedded", {}, { timeout: 3000 }),
    ).toBeInTheDocument()
    expect(screen.queryByTestId("code-frame")).toBeNull()
    expect(screen.getByTestId("code-new-tab-fallback")).toHaveAttribute(
      "href",
      expect.stringContaining("__auth"),
    )
  })

  it("shows an offline banner and never loads a cached Code UI", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false })

    renderCode()
    expect(await screen.findByTestId("code-offline")).toHaveTextContent(
      "You are offline. Code is not shown from cache; reconnect and reload.",
    )
    expect(screen.queryByTestId("code-frame")).toBeNull()
    expect(mocks.codeTicket).not.toHaveBeenCalled()
  })

  it("shows the mobile notice with a new tab instead of a frame", async () => {
    stubViewport(false)

    renderCode()
    expect(await screen.findByText("Code needs a larger screen")).toBeInTheDocument()
    expect(screen.queryByTestId("code-frame")).toBeNull()
    await waitFor(() =>
      expect(screen.getByTestId("code-new-tab-fallback")).toHaveAttribute(
        "href",
        expect.stringContaining("__auth"),
      ),
    )
  })

  it("shows a narrow bar state instead of Loading or Blocked", async () => {
    stubViewport(false)

    renderCode("/code", { loadTimeoutMs: 20 })
    expect(await screen.findByText("Code needs a larger screen")).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId("code-new-tab-fallback")).toHaveAttribute(
        "href",
        expect.stringContaining("__auth"),
      ),
    )

    // Longer than the load timeout: the skipped timer must never flip the bar.
    await new Promise((resolve) => setTimeout(resolve, 60))

    const state = screen.getByTestId("code-state")
    expect(state).toHaveTextContent("Desktop only")
    expect(state).not.toHaveTextContent("Loading")
    expect(state).not.toHaveTextContent("Blocked")
    expect(screen.queryByTestId("code-frame")).toBeNull()
    expect(screen.getByTestId("code-bar")).toHaveAttribute("role", "banner")
    // The narrow bar uses the short label so it stays on one row.
    expect(screen.getByTestId("code-new-tab")).toHaveTextContent("New tab")
    expect(screen.getByTestId("code-new-tab")).not.toHaveTextContent("Open Code in a new tab")
  })

  it("re-mints the ticket on reload and keeps one switch in the bar", async () => {
    const user = userEvent.setup()
    renderCode()
    const first = await screen.findByTestId("code-frame")
    const firstSrc = first.getAttribute("src")
    const bar = screen.getByTestId("code-bar")
    expect(within(bar).getByTestId("surface-switch")).toBeInTheDocument()
    expect(screen.getAllByTestId("surface-switch")).toHaveLength(1)

    await user.click(screen.getByTestId("code-reload"))

    await waitFor(() =>
      expect(screen.getByTestId("code-frame").getAttribute("src")).not.toBe(firstSrc),
    )
    expect(mocks.codeTicket).toHaveBeenCalledTimes(4)
  })

  it("moves focus back to the bar on Escape", async () => {
    renderCode()
    const frame = await screen.findByTestId("code-frame")
    const bar = screen.getByTestId("code-bar")
    frame.focus()
    expect(frame).toHaveFocus()

    fireEvent.keyDown(window, { key: "Escape" })
    expect(document.activeElement).toBe(bar)
    expect(bar).toHaveFocus()
    // A visible replacement indicator, not just the removed `outline-none`.
    expect(bar.className).toMatch(/focus-visible:outline-2/)
    expect(bar.className).toMatch(/focus-visible:outline-focus-ring/)
  })
})

describe("Code route", () => {
  it("redirects to chat when the Code host is not configured", async () => {
    mocks.info.mockResolvedValue({ code: { configured: false, expectedVersion: "2.3.0" } })
    providers(
      "/code",
      <Routes>
        <Route path="/code" element={<CodeRoute />} />
        <Route path="/code/*" element={<CodeRoute />} />
        <Route path="/" element={<p>chat home</p>} />
      </Routes>,
    )

    expect(await screen.findByText("chat home")).toBeInTheDocument()
    expect(mocks.codeTicket).not.toHaveBeenCalled()
  })
})
