import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SurfaceProvider } from "../src/code/SurfaceProvider"
import { AppShell } from "../src/components/AppShell"
import { I18nProvider } from "../src/i18n/provider"
import { useReportPaletteChat } from "../src/palette/current-chat"
import { ThemeProvider } from "../src/theme/provider"

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  search: vi.fn(),
  create: vi.fn(),
  sessions: [] as Array<{
    id: string
    title: string
    directory: string
    created: number
    updated: number
  }>,
}))

vi.mock("../src/api/client", () => ({ api: mocks }))

vi.mock("../src/chat/sessions", () => ({
  useSessions: () => ({
    sessions: mocks.sessions,
    loading: false,
    failed: false,
    refresh: vi.fn(),
    create: mocks.create,
  }),
}))

function ChatProbe() {
  const { sessionId = "" } = useParams()
  useReportPaletteChat({
    sessionID: sessionId,
    title: "Palette chat",
    lastAnswer: "The answer",
  })
  return <p>chat page</p>
}

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>
}

function renderShell(locale: "en" | "de" = "en", initial = "/") {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale={locale}>
        <MemoryRouter initialEntries={[initial]}>
          <SurfaceProvider>
            <LocationProbe />
            <Routes>
              <Route element={<AppShell />}>
                <Route index element={<p>home</p>} />
                <Route path="/settings" element={<p>settings page</p>} />
                <Route path="/c/:sessionId" element={<ChatProbe />} />
              </Route>
            </Routes>
          </SurfaceProvider>
        </MemoryRouter>
      </I18nProvider>
    </ThemeProvider>,
  )
}

function searchResponse(hits: Array<Record<string, unknown>>) {
  return {
    query: "Design",
    available: ["chats"],
    groups: [{ source: "chats", state: "ok", total: hits.length, hits }],
  }
}

const writeText = vi.fn(async () => undefined)

beforeEach(() => {
  mocks.sessions = []
  mocks.info.mockResolvedValue({
    code: { configured: true, expectedVersion: "2.3.0" },
    apps: { available: true },
    artifacts: { available: true },
  })
  mocks.search.mockResolvedValue(searchResponse([]))
  mocks.create.mockResolvedValue({ id: "ses_new" })
  writeText.mockReset()
  writeText.mockResolvedValue(undefined)
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText, readText: vi.fn(async () => "") },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("command palette", () => {
  it("opens with Ctrl+K, traps Tab and closes with Escape", async () => {
    renderShell()

    fireEvent.keyDown(window, { key: "k", ctrlKey: true })
    const dialog = await screen.findByRole("dialog", { name: "Command palette" })
    expect(dialog).toHaveAttribute("aria-modal", "true")

    const input = screen.getByTestId("palette-input")
    await waitFor(() => expect(input).toHaveFocus())
    expect(input).toHaveAttribute("aria-expanded", "true")
    expect(input.getAttribute("aria-activedescendant")).toMatch(/^palette-option-/)

    // The page behind is inert while the palette is open.
    expect(screen.getByTestId("app-content")).toHaveAttribute("inert")

    const close = screen.getByRole("button", { name: "Close command palette" })
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true })
    expect(close).toHaveFocus()
    fireEvent.keyDown(close, { key: "Tab" })
    expect(input).toHaveFocus()

    fireEvent.keyDown(input, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByTestId("palette-open")).toHaveFocus())
  })

  it("opens from the app bar and runs an action", async () => {
    const user = userEvent.setup()
    renderShell()

    await user.click(screen.getByTestId("palette-open"))
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeVisible()

    await user.click(screen.getByRole("option", { name: "Go to settings" }))
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/settings"))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("debounces chat search, shows the snippet and opens the hit with Enter", async () => {
    const user = userEvent.setup()
    renderShell()

    await user.click(screen.getByTestId("palette-open"))
    const input = screen.getByTestId("palette-input")

    mocks.search.mockResolvedValueOnce(
      searchResponse([
        {
          source: "chats",
          id: "message-msg_1",
          title: "Design chat",
          snippet: "a snippet from the transcript",
          sessionID: "ses_1",
          messageID: "msg_1",
        },
      ]),
    )
    fireEvent.change(input, { target: { value: "Design" } })

    // Nothing leaves the browser before the debounce elapses.
    expect(mocks.search).not.toHaveBeenCalled()
    expect(await screen.findByText("Searching chats…")).toBeVisible()

    const hit = await screen.findByTestId("palette-chat-option")
    expect(hit).toHaveTextContent("Design chat")
    expect(hit).toHaveTextContent("a snippet from the transcript")
    expect(mocks.search).toHaveBeenCalledTimes(1)
    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({ query: "Design", sources: ["chats"] }),
    )

    await waitFor(() =>
      expect(input).toHaveAttribute("aria-activedescendant", "palette-option-chat-ses_1-0"),
    )
    fireEvent.keyDown(input, { key: "Enter" })

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/c/ses_1"))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("lists recent chats for an empty query", async () => {
    mocks.sessions = [
      { id: "ses_a", title: "Alpha", directory: "/w", created: 1, updated: 2 },
      { id: "ses_b", title: "Beta", directory: "/w", created: 2, updated: 1 },
    ]
    const user = userEvent.setup()
    renderShell()

    await user.click(screen.getByTestId("palette-open"))
    expect(screen.getByText("Recent chats")).toBeVisible()
    const options = screen.getAllByTestId("palette-chat-option")
    expect(options[0]).toHaveTextContent("Alpha")
    expect(options[1]).toHaveTextContent("Beta")

    const input = screen.getByTestId("palette-input")
    await waitFor(() =>
      expect(input).toHaveAttribute("aria-activedescendant", "palette-option-new-chat"),
    )
    fireEvent.keyDown(input, { key: "End" })
    await waitFor(() =>
      expect(input).toHaveAttribute("aria-activedescendant", "palette-option-recent-ses_b"),
    )
    fireEvent.keyDown(input, { key: "ArrowUp" })
    await waitFor(() =>
      expect(input).toHaveAttribute("aria-activedescendant", "palette-option-recent-ses_a"),
    )
    fireEvent.keyDown(input, { key: "Home" })
    await waitFor(() =>
      expect(input).toHaveAttribute("aria-activedescendant", "palette-option-new-chat"),
    )

    await user.click(options[1]!)
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/c/ses_b"))
  })

  it("copies the current answer and announces it", async () => {
    renderShell("en", "/c/ses_1")

    fireEvent.click(screen.getByTestId("palette-open"))
    fireEvent.click(screen.getByRole("option", { name: "Copy current answer" }))

    expect(writeText).toHaveBeenCalledWith("The answer")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(screen.getByTestId("palette-status")).toHaveTextContent("Answer copied to clipboard.")
  })

  it("keeps copy disabled when no answer exists", async () => {
    const user = userEvent.setup()
    renderShell()

    await user.click(screen.getByTestId("palette-open"))
    const option = screen.getByRole("option", { name: /Copy current answer/ })
    expect(option).toHaveAttribute("aria-disabled", "true")
    await user.click(option)
    expect(writeText).not.toHaveBeenCalled()
  })

  it("uses the German labels and placeholder", async () => {
    renderShell("de")

    fireEvent.keyDown(window, { key: "k", metaKey: true })
    expect(await screen.findByRole("dialog", { name: "Befehlspalette" })).toBeVisible()
    expect(screen.getByTestId("palette-input")).toHaveAttribute(
      "placeholder",
      "Chats durchsuchen oder einen Befehl ausführen",
    )
    expect(screen.getByRole("option", { name: "Neuer Chat" })).toBeVisible()
  })
})
