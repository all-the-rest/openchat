import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { SurfaceProvider } from "../src/code/SurfaceProvider"
import { AppShell } from "../src/components/AppShell"
import { I18nProvider } from "../src/i18n/provider"
import { LandingPage } from "../src/pages/LandingPage"
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

vi.mock("../src/api/events", () => ({
  useEventStream: () => ({ connection: "open", reconnect: 0 }),
}))

const healthy = {
  host: { reachable: true },
  code: { configured: true, expectedVersion: "2.3.0" },
  apps: { available: true },
}

const down = {
  host: { reachable: false },
  code: { configured: true, expectedVersion: "2.3.0" },
  apps: { available: true },
}

function renderShell(entry: string) {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale="en">
        <MemoryRouter initialEntries={[entry]}>
          <SurfaceProvider>
            <Routes>
              <Route element={<AppShell />}>
                <Route index element={<LandingPage />} />
                <Route path="/search" element={<p>search page</p>} />
              </Route>
            </Routes>
          </SurfaceProvider>
        </MemoryRouter>
      </I18nProvider>
    </ThemeProvider>,
  )
}

beforeEach(() => {
  mocks.info.mockReset()
  mocks.create.mockReset()
  mocks.create.mockResolvedValue({
    id: "ses_new",
    title: "",
    directory: "",
    created: 0,
    updated: 0,
  })
})

describe("host unreachable banner", () => {
  it("is absent while the host answers", async () => {
    mocks.info.mockResolvedValue(healthy)
    renderShell("/")

    // The switch renders only after the reachable answer was applied.
    await screen.findByTestId("surface-switch")
    expect(screen.queryByTestId("host-unreachable")).toBeNull()
  })

  it("appears on a protected route as a polite status directly under the bar", async () => {
    mocks.info.mockResolvedValue(down)
    renderShell("/search")

    const banner = await screen.findByTestId("host-unreachable")
    expect(await screen.findByText("search page")).toBeInTheDocument()
    expect(banner).toHaveAttribute("role", "status")
    expect(banner).toHaveAttribute("aria-live", "polite")
    expect(banner).toHaveTextContent("OpenCode host not reachable")
    expect(banner).toHaveTextContent("The app is running, but the OpenCode host did not answer.")
    expect(screen.getByTestId("app-bar").nextElementSibling).toBe(banner)
    expect(banner).toContainElement(screen.getByRole("button", { name: "Retry" }))
  })

  it("treats a failed info request as unreachable", async () => {
    mocks.info.mockRejectedValue(new Error("bff down"))
    renderShell("/search")

    expect(await screen.findByTestId("host-unreachable")).toBeInTheDocument()
  })

  it("retries /api/info once and hides the banner when the host is back", async () => {
    const user = userEvent.setup()
    mocks.info.mockResolvedValueOnce(down)
    renderShell("/search")

    await screen.findByTestId("host-unreachable")
    expect(mocks.info).toHaveBeenCalledTimes(1)

    mocks.info.mockResolvedValue(healthy)
    await user.click(screen.getByRole("button", { name: "Retry" }))

    await waitFor(() => expect(screen.queryByTestId("host-unreachable")).toBeNull())
    expect(mocks.info).toHaveBeenCalledTimes(2)
  })
})

describe("composer during a host outage", () => {
  it("keeps the draft, blocks send, and re-enables it after a reachable retry", async () => {
    const user = userEvent.setup()
    mocks.info.mockResolvedValue(down)
    renderShell("/")

    await screen.findByTestId("host-unreachable")
    const composer = screen.getByTestId("composer") as HTMLTextAreaElement
    await user.type(composer, "draft while down")

    expect(composer).toBeEnabled()
    expect(composer).toHaveValue("draft while down")
    expect(screen.getByTestId("send")).toBeDisabled()

    // Enter edits the draft instead of firing a request that cannot succeed.
    await user.type(composer, "{Enter}")
    expect(mocks.create).not.toHaveBeenCalled()

    mocks.info.mockResolvedValue(healthy)
    await user.click(screen.getByRole("button", { name: "Retry" }))

    await waitFor(() => expect(screen.getByTestId("send")).toBeEnabled())
    expect(screen.queryByTestId("host-unreachable")).toBeNull()
    expect(composer).toHaveValue("draft while down\n")

    await user.click(screen.getByTestId("send"))
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1))
  })
})
