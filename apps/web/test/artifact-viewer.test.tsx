import type { ArtifactResponse } from "@openchat/contracts"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "../src/api/client"
import { ArtifactViewer } from "../src/artifacts/ArtifactViewer"
import { artifactFilename, needsFreshURL } from "../src/artifacts/files"
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

const ID = "a".repeat(64)
const HTML = "<!doctype html><html><body>calculator</body></html>"
const LATER = "2099-01-01T00:00:00.000Z"

function artifact(overrides: Partial<ArtifactResponse> = {}): ArtifactResponse {
  return {
    id: ID,
    title: "Interest calculator",
    bytes: 4096,
    createdAt: "2026-11-18T12:00:00.000Z",
    url: `https://artifacts.example.test/a/${ID}?exp=4070908800&sig=${"s".repeat(43)}`,
    expiresAt: LATER,
    ...overrides,
  }
}

let savedBlob: Blob | null
let savedLink: HTMLAnchorElement | null

beforeEach(() => {
  mocks.info.mockReset()
  mocks.artifact.mockReset()
  mocks.artifactDownload.mockReset()
  mocks.info.mockResolvedValue({ artifacts: { available: true } })
  mocks.artifact.mockResolvedValue(artifact())

  savedBlob = null
  savedLink = null
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn((blob: Blob) => {
      savedBlob = blob
      return "blob:test-download"
    }),
  })
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() })
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    savedLink = this
  })
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

function renderViewer(props: { loadTimeoutMs?: number } = {}) {
  return providers(<ArtifactViewer {...props} />)
}

describe("artifact viewer", () => {
  it("uses the BFF's signed URL verbatim in the documented sandbox", async () => {
    const first = artifact()
    mocks.artifact.mockResolvedValue(first)
    renderViewer()

    const frame = await screen.findByTestId("artifact-frame")
    expect(mocks.artifact).toHaveBeenCalledWith(ID)
    expect(frame).toHaveAttribute("src", first.url)
    expect(frame).toHaveAttribute("sandbox", "allow-scripts")
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin")
    expect(frame).toHaveAttribute("title", "Interest calculator")
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer")
    expect(screen.getByTestId("artifact-viewer-meta")).toHaveTextContent("Nov")
    // The draft panel belongs to a result; nothing arrives on a plain load.
    expect(screen.queryByTestId("artifact-draft")).toBeNull()
  })

  it("shows the result panel even when the route passes no callback", async () => {
    renderViewer()
    const frame = (await screen.findByTestId("artifact-frame")) as HTMLIFrameElement
    const posted: unknown[][] = []
    const source = {
      postMessage: vi.fn((message: unknown) => {
        posted.push([message])
      }),
    }
    Object.defineProperty(frame, "contentWindow", { configurable: true, value: source })
    fireEvent.load(frame)

    const init = posted[0]?.[0] as Record<string, unknown>
    const event = new MessageEvent("message", {
      data: { type: "artifact:result", nonce: init.nonce, text: "local draft" },
    })
    Object.defineProperty(event, "source", { configurable: true, value: source })
    await act(async () => {
      window.dispatchEvent(event)
    })

    expect(screen.getByRole("region", { name: "Artifact result" })).toBeInTheDocument()
    expect(screen.getByLabelText("Text")).toHaveValue("local draft")
    expect(screen.getByTestId("artifact-frame")).toBe(frame)
  })

  it("shows the loading state before the metadata arrives", async () => {
    let release!: (value: ArtifactResponse) => void
    mocks.artifact.mockReturnValue(new Promise<ArtifactResponse>((resolve) => (release = resolve)))
    renderViewer()

    expect(await screen.findByTestId("artifact-viewer-loading")).toHaveTextContent(
      "Loading artifact…",
    )

    release(artifact())
    expect(await screen.findByTestId("artifact-frame")).toBeInTheDocument()
  })

  it("explains a deleted artifact and offers the list", async () => {
    mocks.artifact.mockRejectedValue(new ApiError(404, "Unknown artifact", "artifacts_unknown"))
    renderViewer()

    expect(await screen.findByText("Artifact not available")).toBeInTheDocument()
    expect(
      screen.getByText("It may have been deleted. The list shows what is still stored."),
    ).toBeInTheDocument()
    expect(screen.queryByTestId("artifact-frame")).toBeNull()
    const backLinks = screen.getAllByRole("link", { name: "Back to artifacts" })
    expect(backLinks.length).toBeGreaterThan(0)
    for (const link of backLinks) expect(link).toHaveAttribute("href", "/artifacts")
  })

  it("reports a failed metadata read and retries it", async () => {
    const user = userEvent.setup()
    mocks.artifact
      .mockRejectedValueOnce(new ApiError(502, "host down", "artifacts_unavailable"))
      .mockResolvedValueOnce(artifact())
    renderViewer()

    expect(await screen.findByText("The artifact could not be loaded")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Retry" }))

    expect(await screen.findByTestId("artifact-frame")).toBeInTheDocument()
    expect(mocks.artifact).toHaveBeenCalledTimes(2)
  })

  it("replaces a URL that is already at the end of its lifetime", async () => {
    const expired = artifact({ expiresAt: "2000-01-01T00:00:00.000Z" })
    const fresh = artifact({
      url: `https://artifacts.example.test/a/${ID}?exp=4070909999&sig=${"f".repeat(43)}`,
    })
    mocks.artifact.mockResolvedValueOnce(expired).mockResolvedValueOnce(fresh)
    renderViewer()

    const frame = await screen.findByTestId("artifact-frame")
    expect(frame).toHaveAttribute("src", fresh.url)
    expect(mocks.artifact).toHaveBeenCalledTimes(2)
  })

  it("re-fetches the metadata once and then shows a recoverable error", async () => {
    const fresh = artifact({
      url: `https://artifacts.example.test/a/${ID}?exp=4070909999&sig=${"f".repeat(43)}`,
    })
    mocks.artifact
      .mockResolvedValueOnce(artifact())
      .mockResolvedValueOnce(fresh)
      .mockRejectedValueOnce(new ApiError(502, "host down", "artifacts_unavailable"))
    renderViewer({ loadTimeoutMs: 0 })

    // The frame never loads: the first timeout re-reads the metadata and uses
    // the fresh URL; the second timeout ends in the recoverable panel.
    expect(await screen.findByText("This artifact link has expired")).toBeInTheDocument()
    expect(screen.queryByTestId("artifact-frame")).toBeNull()
    expect(screen.getByTestId("artifact-stale-retry")).toBeInTheDocument()
    // Exactly one recovery read, then the panel: the recovery mints a fresh
    // URL, so anything keyed on the URL would keep re-reading.
    expect(mocks.artifact).toHaveBeenCalledTimes(2)
  })

  it("ends in the stale panel when every re-read succeeds but the frame never loads", async () => {
    // A host that answers the metadata but refuses to load the frame would mint
    // a new URL on every recovery; keyed on the URL that guard never fires.
    let reads = 0
    mocks.artifact.mockImplementation(async () => {
      reads += 1
      return artifact({
        url: `https://artifacts.example.test/a/${ID}?exp=4070909999&sig=${String(reads).padStart(43, "r")}`,
      })
    })
    renderViewer({ loadTimeoutMs: 0 })

    expect(await screen.findByText("This artifact link has expired")).toBeInTheDocument()
    expect(screen.queryByTestId("artifact-frame")).toBeNull()
    expect(reads).toBe(2)
  })

  it("resets the app in place without minting a new URL", async () => {
    const user = userEvent.setup()
    renderViewer()

    const before = await screen.findByTestId("artifact-frame")
    expect(before).toHaveAttribute("src", artifact().url)

    await user.click(screen.getByTestId("artifact-reset"))

    // Reset remounts the frame with the same signed URL: no second metadata
    // read, no new signature, no lost present mode.
    const after = await screen.findByTestId("artifact-frame")
    expect(after).not.toBe(before)
    expect(after).toHaveAttribute("src", artifact().url)
    expect(mocks.artifact).toHaveBeenCalledTimes(1)
  })

  it("presents in the content area and returns focus on Escape", async () => {
    const user = userEvent.setup()
    renderViewer()

    const frame = (await screen.findByTestId("artifact-frame")) as HTMLIFrameElement
    const posted: unknown[] = []
    const source = {
      postMessage: vi.fn((message: unknown) => {
        posted.push(message)
      }),
    }
    Object.defineProperty(frame, "contentWindow", { configurable: true, value: source })
    fireEvent.load(frame)
    const init = posted[0] as { nonce?: string }
    const ready = new MessageEvent("message", {
      data: { type: "artifact:ready", nonce: init.nonce },
    })
    Object.defineProperty(ready, "source", { configurable: true, value: source })
    await act(async () => {
      window.dispatchEvent(ready)
    })

    const present = await screen.findByTestId("artifact-present")
    await user.click(present)

    const layer = await screen.findByTestId("artifact-present-layer")
    expect(layer).toBeInTheDocument()
    expect(screen.getByTestId("artifact-present-bar")).toBeInTheDocument()
    expect(screen.queryByTestId("artifact-back")).toBeNull()
    expect(screen.getByTestId("artifact-frame")).toBeInTheDocument()
    expect(screen.getByTestId("artifact-exit-present")).toHaveFocus()

    fireEvent.keyDown(window, { key: "Escape" })

    await waitFor(() => expect(screen.queryByTestId("artifact-present-layer")).toBeNull())
    expect(screen.getByTestId("artifact-present")).toHaveFocus()
    expect(screen.getByTestId("artifact-frame")).toBeInTheDocument()
  })

  it("downloads the stored bytes through the BFF under the artifact's title", async () => {
    const user = userEvent.setup()
    mocks.artifactDownload.mockResolvedValue(new Blob([HTML], { type: "text/html" }))
    renderViewer()

    await screen.findByTestId("artifact-frame")
    await user.click(screen.getByTestId("artifact-download"))

    await waitFor(() => expect(savedLink).not.toBeNull())
    expect(mocks.artifactDownload).toHaveBeenCalledWith(ID)
    expect(savedLink?.download).toBe("Interest calculator.html")
    expect(savedLink?.href).toBe("blob:test-download")
    expect(await savedBlob?.text()).toBe(HTML)
    expect(await savedBlob?.text()).not.toContain(artifact().url)
  })

  it("reports a failed download without losing the frame", async () => {
    const user = userEvent.setup()
    mocks.artifactDownload.mockRejectedValue(new ApiError(502, "host down"))
    renderViewer()

    await screen.findByTestId("artifact-frame")
    await user.click(screen.getByTestId("artifact-download"))

    expect(await screen.findByText("The download failed. Try again.")).toBeInTheDocument()
    expect(screen.getByTestId("artifact-frame")).toBeInTheDocument()
  })
})

describe("artifact download names", () => {
  it("adds the HTML extension once", () => {
    expect(artifactFilename("Interest calculator")).toBe("Interest calculator.html")
    expect(artifactFilename("Report.HTML")).toBe("Report.HTML")
  })

  it("never turns a title into a path", () => {
    expect(artifactFilename("../../etc/passwd")).toBe("etc passwd.html")
    expect(artifactFilename("..\\..\\Windows\\win.ini")).toBe("Windows win.ini.html")
    expect(artifactFilename("a\u0000b")).toBe("a b.html")
  })

  it("falls back for a title that sanitises to nothing", () => {
    expect(artifactFilename("...")).toBe("artifact.html")
    expect(artifactFilename("   ")).toBe("artifact.html")
  })
})

describe("artifact URL freshness", () => {
  it("asks for a fresh URL inside the refresh margin", () => {
    const now = Date.UTC(2026, 10, 18, 12, 0, 0)
    expect(needsFreshURL(new Date(now + 59_000).toISOString(), now)).toBe(true)
    expect(needsFreshURL(new Date(now + 61_000).toISOString(), now)).toBe(false)
    expect(needsFreshURL("not a date", now)).toBe(true)
  })
})
