import type { ArtifactResponse } from "@openchat/contracts"
import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ArtifactsRoute } from "../src/App"
import { ArtifactsPage } from "../src/artifacts/ArtifactsPage"
import { SurfaceProvider } from "../src/code/SurfaceProvider"
import { I18nProvider } from "../src/i18n/provider"
import { ThemeProvider } from "../src/theme/provider"

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  artifacts: vi.fn(),
}))

vi.mock("../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/client")>()
  return { ...actual, api: mocks }
})

const ID = "a".repeat(64)

function artifact(overrides: Partial<ArtifactResponse> = {}): ArtifactResponse {
  return {
    id: ID,
    title: "Interest calculator",
    bytes: 4096,
    createdAt: "2026-11-18T12:00:00.000Z",
    url: `https://artifacts.example.test/a/${ID}?exp=1763488800&sig=${"s".repeat(43)}`,
    expiresAt: "2026-11-18T13:00:00.000Z",
    ...overrides,
  }
}

beforeEach(() => {
  mocks.info.mockReset()
  mocks.artifacts.mockReset()
  mocks.info.mockResolvedValue({
    code: { configured: false, expectedVersion: "2" },
    apps: { available: false },
    artifacts: { available: true },
  })
  mocks.artifacts.mockResolvedValue([artifact()])
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function providers(entry: string, children: ReactNode) {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale="en">
        <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter>
      </I18nProvider>
    </ThemeProvider>,
  )
}

function renderPage() {
  return providers("/artifacts", <ArtifactsPage />)
}

function renderRoute() {
  return providers(
    "/artifacts",
    <SurfaceProvider>
      <Routes>
        <Route
          path="/artifacts"
          element={
            <ArtifactsRoute>
              <ArtifactsPage />
            </ArtifactsRoute>
          }
        />
        <Route path="/" element={<p>chat home</p>} />
      </Routes>
    </SurfaceProvider>,
  )
}

describe("artifacts page", () => {
  it("lists title, size and write time from the BFF metadata", async () => {
    mocks.artifacts.mockResolvedValue([
      artifact(),
      artifact({ id: "b".repeat(64), title: "Quarterly chart", bytes: 900 }),
    ])
    renderPage()

    const items = await screen.findAllByTestId("artifact-item")
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveAttribute("href", `/artifacts/${ID}`)
    expect(items[0]).toHaveAttribute("aria-label", "Open Interest calculator")
    expect(within(items[0] as HTMLElement).getByTestId("artifact-title")).toHaveTextContent(
      "Interest calculator",
    )
    expect(within(items[0] as HTMLElement).getByTestId("artifact-meta")).toHaveTextContent("Nov")
    expect(items[1]).toHaveTextContent("Quarterly chart")
  })

  it("shows a spinner while the first read is in flight", async () => {
    let release!: (value: ArtifactResponse[]) => void
    mocks.artifacts.mockReturnValue(
      new Promise<ArtifactResponse[]>((resolve) => (release = resolve)),
    )
    renderPage()

    expect(await screen.findByTestId("artifacts-loading")).toHaveTextContent(
      "Loading artifacts…",
    )

    await act(async () => release([artifact()]))
    expect(await screen.findByTestId("artifact-item")).toBeInTheDocument()
  })

  it("explains that an artifact appears once the agent writes one", async () => {
    mocks.artifacts.mockResolvedValue([])
    renderPage()

    expect(await screen.findByTestId("artifacts-empty")).toHaveTextContent("No artifacts yet")
    expect(screen.getByTestId("artifacts-empty")).toHaveTextContent(
      "An artifact appears here once the agent writes one with the app tool.",
    )
    expect(screen.queryByTestId("artifact-item")).toBeNull()
  })

  it("reports a failed read and retries it", async () => {
    const user = userEvent.setup()
    mocks.artifacts.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([artifact()])
    renderPage()

    expect(await screen.findByText("Artifacts could not be loaded.")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Retry" }))

    expect(await screen.findByTestId("artifact-item")).toBeInTheDocument()
    expect(mocks.artifacts).toHaveBeenCalledTimes(2)
  })

  it("redirects to chat and never reads the list when artifacts are unconfigured", async () => {
    mocks.info.mockResolvedValue({ artifacts: { available: false } })
    renderRoute()

    expect(await screen.findByText("chat home")).toBeInTheDocument()
    expect(mocks.artifacts).not.toHaveBeenCalled()
  })

  it("renders the list when /api/info reports the artifact surface", async () => {
    renderRoute()

    expect(await screen.findByRole("heading", { level: 1, name: "Artifacts" })).toBeVisible()
    expect(await screen.findByTestId("artifact-item")).toBeInTheDocument()
  })
})
