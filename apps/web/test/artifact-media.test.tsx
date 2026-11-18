import type { ArtifactResponse } from "@openchat/contracts"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ArtifactCard } from "../src/artifacts/ArtifactCard"
import { ImageGallery } from "../src/artifacts/ImageGallery"
import { PdfPreview } from "../src/artifacts/PdfPreview"
import { isImageArtifact, isTrustedArtifactUrl } from "../src/artifacts/media"
import { I18nProvider } from "../src/i18n/provider"

const mocks = vi.hoisted(() => ({ artifactDownload: vi.fn(), artifact: vi.fn() }))
vi.mock("../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/client")>()
  return { ...actual, api: mocks }
})

const ID = "a".repeat(64)
const OTHER = "b".repeat(64)
const ORIGIN = "https://artifacts.example.test"
const SIG = "s".repeat(43)
const URL = `${ORIGIN}/a/${ID}?exp=1763488800&sig=${SIG}`

function artifact(overrides: Partial<ArtifactResponse> = {}): ArtifactResponse {
  return {
    id: ID,
    title: "Quarterly chart",
    bytes: 2048,
    createdAt: "2026-11-18T12:00:00.000Z",
    url: URL,
    expiresAt: "2026-11-18T13:00:00.000Z",
    mime: "image/png",
    ...overrides,
  }
}

function renderView(ui: ReactNode) {
  return render(
    <I18nProvider initialLocale="en">
      <MemoryRouter>{ui}</MemoryRouter>
    </I18nProvider>,
  )
}

beforeEach(() => {
  mocks.artifactDownload.mockReset()
  mocks.artifact.mockReset()
})

describe("artifact URL trust", () => {
  it("accepts a signed artifact URL for the same id", () => {
    expect(isTrustedArtifactUrl(URL, ID, ORIGIN)).toBe(true)
    expect(isTrustedArtifactUrl(URL, ID)).toBe(true)
  })

  it.each([
    ["another artifact's id", `${ORIGIN}/a/${OTHER}?exp=1763488800&sig=${SIG}`, ID, ORIGIN],
    ["a third-party origin", `https://cdn.example.net/a/${ID}?exp=1763488800&sig=${SIG}`, ID, ORIGIN],
    ["a data URL", `data:image/png;base64,AAAA`, ID, ORIGIN],
    ["a relative URL", `/a/${ID}?exp=1763488800&sig=${SIG}`, ID, ORIGIN],
    ["a missing signature", `${ORIGIN}/a/${ID}?exp=1763488800`, ID, ORIGIN],
  ])("rejects %s", (_label, url, id, origin) => {
    expect(isTrustedArtifactUrl(String(url), String(id), String(origin))).toBe(false)
  })

  it("only treats the four image MIME types as images", () => {
    expect(isImageArtifact(artifact())).toBe(true)
    expect(isImageArtifact(artifact({ mime: "image/svg+xml" }))).toBe(false)
    expect(isImageArtifact(artifact({ mime: "text/html" }))).toBe(false)
    expect(isImageArtifact(artifact({ mime: undefined }))).toBe(false)
  })
})

describe("artifact image card", () => {
  it("renders a lazy image with alt text and token-capped dimensions", () => {
    renderView(<ArtifactCard artifact={artifact()} />)
    const image = screen.getByTestId("artifact-image")
    expect(image).toHaveAttribute("src", URL)
    expect(image).toHaveAttribute("alt", "Quarterly chart")
    expect(image).toHaveAttribute("loading", "lazy")
    expect(image.className).toContain("max-h-image-preview")
    expect(screen.getByTestId("artifact-image-card")).toBeInTheDocument()
  })

  it("downgrades to a generic card when the URL is not a trusted signed URL", () => {
    renderView(
      <ArtifactCard artifact={artifact({ url: "https://cdn.example.net/chart.png" })} artifactOrigin={ORIGIN} />,
    )
    expect(screen.getByTestId("artifact-file-card")).toBeInTheDocument()
    expect(screen.queryByTestId("artifact-image")).not.toBeInTheDocument()
    expect(screen.queryByTestId("artifact-image-card")).not.toBeInTheDocument()
  })

  it("uses the sniffed MIME for the download filename", async () => {
    mocks.artifactDownload.mockResolvedValue(new Blob(["png"]))
    const create = vi.fn(() => "blob:test")
    const revoke = vi.fn()
    Object.defineProperty(globalThis.URL, "createObjectURL", { value: create, configurable: true })
    Object.defineProperty(globalThis.URL, "revokeObjectURL", { value: revoke, configurable: true })
    renderView(<ArtifactCard artifact={artifact()} />)
    await userEvent.click(screen.getByTestId("artifact-card-download"))
    await waitFor(() => expect(mocks.artifactDownload).toHaveBeenCalledWith(ID))
    expect(create).toHaveBeenCalled()
  })
})

describe("PDF preview", () => {
  const pdf = artifact({ mime: "application/pdf", url: `${ORIGIN}/a/${ID}?exp=1763488800&sig=${SIG}` })

  it("embeds only the artifact origin's signed URL in a sandboxed frame", () => {
    renderView(<PdfPreview artifact={pdf} artifactOrigin={ORIGIN} />)
    const frame = screen.getByTestId("artifact-pdf-frame")
    expect(frame).toHaveAttribute("src", pdf.url)
    expect(frame).toHaveAttribute("sandbox", "allow-scripts")
    expect(frame).not.toHaveAttribute("srcdoc")
    expect(frame.getAttribute("src")).not.toMatch(/^data:|cdn\.example/)
  })

  it("renders nothing for a third-party URL", () => {
    const { container } = renderView(
      <PdfPreview artifact={{ ...pdf, url: "https://cdn.example.net/doc.pdf" }} artifactOrigin={ORIGIN} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe("image gallery", () => {
  it("shows only image artifacts as links that open the viewer", () => {
    renderView(
      <ImageGallery
        artifacts={[
          artifact(),
          artifact({ id: OTHER, title: "Report", mime: "application/pdf" }),
        ]}
        artifactOrigin={ORIGIN}
      />,
    )
    expect(screen.getByTestId("artifact-gallery")).toBeInTheDocument()
    expect(screen.getAllByTestId("artifact-gallery-item")).toHaveLength(1)
    const link = screen.getByRole("link", { name: "Open Quarterly chart" })
    expect(link).toHaveAttribute("href", `/artifacts/${ID}`)
    expect(screen.getByTestId("artifact-gallery-image")).toHaveAttribute("loading", "lazy")
  })

  it("renders nothing without image artifacts", () => {
    const { container } = renderView(
      <ImageGallery artifacts={[artifact({ mime: "application/pdf" })]} artifactOrigin={ORIGIN} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
