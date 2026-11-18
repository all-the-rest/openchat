import type { ArtifactResponse } from "@openchat/contracts"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "../src/api/client"
import { ArtifactViewer } from "../src/artifacts/ArtifactViewer"
import { ARTIFACT_HANDSHAKE_GRACE_MS } from "../src/artifacts/document"
import { I18nProvider } from "../src/i18n/provider"
import { ThemeProvider } from "../src/theme/provider"

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  artifact: vi.fn(),
  artifactDownload: vi.fn(),
}))

vi.mock("../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/client")>()
  return { ...actual, api: mocks }
})

const ID = "b".repeat(64)
const LATER = "2099-01-01T00:00:00.000Z"

function artifact(url: string, overrides: Partial<ArtifactResponse> = {}): ArtifactResponse {
  return {
    id: ID,
    title: "Interest calculator",
    bytes: 4096,
    createdAt: "2026-11-18T12:00:00.000Z",
    url,
    expiresAt: LATER,
    ...overrides,
  }
}

const URL_A = `https://artifacts.example.test/a/${ID}?exp=4070908800&sig=${"a".repeat(43)}`
const URL_B = `https://artifacts.example.test/a/${ID}?exp=4070909999&sig=${"b".repeat(43)}`

beforeEach(() => {
  mocks.info.mockReset()
  mocks.artifact.mockReset()
  mocks.artifactDownload.mockReset()
  mocks.info.mockResolvedValue({ artifacts: { available: true } })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function providers(children: ReactNode) {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale="en">
        <MemoryRouter initialEntries={[`/artifacts/${ID}`]}>
          <Routes>
            <Route path="/artifacts/:id" element={children} />
            <Route path="/artifacts" element={<p>artifact list</p>} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </ThemeProvider>,
  )
}

function renderViewer(handshakeGraceMs = 0) {
  return providers(<ArtifactViewer handshakeGraceMs={handshakeGraceMs} loadTimeoutMs={10_000} />)
}

interface FrameControl {
  source: { postMessage: ReturnType<typeof vi.fn> }
  posted: unknown[]
}

/** The frame's contentWindow is opaque in jsdom; the bridge only needs postMessage. */
function control(frame: HTMLIFrameElement): FrameControl {
  const posted: unknown[] = []
  const source = {
    postMessage: vi.fn((message: unknown) => {
      posted.push(message)
    }),
  }
  Object.defineProperty(frame, "contentWindow", { configurable: true, value: source })
  return { source, posted }
}

function nonceOf(posted: unknown[]): string {
  const init = posted.find(
    (message) => (message as { type?: string }).type === "artifact:init",
  ) as { nonce?: string } | undefined
  if (!init?.nonce) throw new Error("artifact:init was not posted")
  return init.nonce
}

/** A load without the handshake is what an expired signed URL looks like. */
function loadSilently(): void {
  fireEvent.load(screen.getByTestId("artifact-frame"))
}

async function handshake(control: FrameControl): Promise<void> {
  fireEvent.load(screen.getByTestId("artifact-frame"))
  const nonce = nonceOf(control.posted)
  const event = new MessageEvent("message", {
    data: { type: "artifact:ready", nonce },
  })
  Object.defineProperty(event, "source", { configurable: true, value: control.source })
  await act(async () => {
    window.dispatchEvent(event)
  })
}

describe("artifact handshake", () => {
  it("pins the grace window at 1.5 s", () => {
    // Three times the bridge's 1 s init-repost interval: a healthy generation-2
    // document has answered, a refused URL is replaced quickly.
    expect(ARTIFACT_HANDSHAKE_GRACE_MS).toBe(1_500)
  })

  it("covers the frame until artifact:ready and never re-mints a speaking frame", async () => {
    mocks.artifact.mockResolvedValue(artifact(URL_A))
    renderViewer()

    const frame = (await screen.findByTestId("artifact-frame")) as HTMLIFrameElement
    expect(screen.getByTestId("artifact-handshake-cover")).toBeInTheDocument()
    const controlWindow = control(frame)

    await handshake(controlWindow)

    await waitFor(() =>
      expect(screen.queryByTestId("artifact-handshake-cover")).toBeNull(),
    )
    expect(screen.getByTestId("artifact-frame")).toBe(frame)
    expect(mocks.artifact).toHaveBeenCalledTimes(1)
  })

  it("re-mints once for a silent frame, then accepts it as generation 1", async () => {
    mocks.artifact.mockResolvedValueOnce(artifact(URL_A)).mockResolvedValueOnce(artifact(URL_B))
    renderViewer()

    const first = (await screen.findByTestId("artifact-frame")) as HTMLIFrameElement
    control(first)
    loadSilently()

    // The silent load is not accepted as the document: one fresh URL is read.
    await waitFor(() => expect(mocks.artifact).toHaveBeenCalledTimes(2))
    const second = (await screen.findByTestId("artifact-frame")) as HTMLIFrameElement
    expect(second).toHaveAttribute("src", URL_B)
    expect(screen.getByTestId("artifact-handshake-cover")).toBeInTheDocument()

    control(second)
    loadSilently()

    // The second silent frame is a generation-1 document, not an error.
    await waitFor(() =>
      expect(screen.queryByTestId("artifact-handshake-cover")).toBeNull(),
    )
    expect(screen.queryByText("This artifact link has expired")).toBeNull()
    expect(screen.getByTestId("artifact-frame")).toHaveAttribute("src", URL_B)
    expect(mocks.artifact).toHaveBeenCalledTimes(2)
  })

  it("shows the translated stale state when the re-mint fails", async () => {
    mocks.artifact
      .mockResolvedValueOnce(artifact(URL_A))
      .mockRejectedValueOnce(new ApiError(502, "host down", "artifacts_unavailable"))
    renderViewer()

    const frame = (await screen.findByTestId("artifact-frame")) as HTMLIFrameElement
    control(frame)
    loadSilently()

    expect(await screen.findByText("This artifact link has expired")).toBeInTheDocument()
    expect(
      screen.getByText("The artifact host refused the link. Reload to request a fresh one."),
    ).toBeInTheDocument()
    expect(screen.queryByTestId("artifact-frame")).toBeNull()
    expect(screen.queryByTestId("artifact-handshake-cover")).toBeNull()
  })

  it("re-mints and reloads the frame from the stale state's Retry", async () => {
    const user = userEvent.setup()
    mocks.artifact
      .mockResolvedValueOnce(artifact(URL_A))
      .mockRejectedValueOnce(new ApiError(502, "host down", "artifacts_unavailable"))
      .mockResolvedValueOnce(artifact(URL_B))
    renderViewer()

    const frame = (await screen.findByTestId("artifact-frame")) as HTMLIFrameElement
    control(frame)
    loadSilently()
    await screen.findByTestId("artifact-stale-retry")

    await user.click(screen.getByTestId("artifact-stale-retry"))

    const fresh = (await screen.findByTestId("artifact-frame")) as HTMLIFrameElement
    expect(fresh).toHaveAttribute("src", URL_B)
    await handshake(control(fresh))
    await waitFor(() =>
      expect(screen.queryByTestId("artifact-handshake-cover")).toBeNull(),
    )
    expect(mocks.artifact).toHaveBeenCalledTimes(3)
    expect(screen.queryByText("This artifact link has expired")).toBeNull()
  })
})
