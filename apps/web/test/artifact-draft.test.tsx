import type { ArtifactResponse } from "@openchat/contracts"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ArtifactViewer } from "../src/artifacts/ArtifactViewer"
import type { ArtifactResult } from "../src/artifacts/bridge"
import { I18nProvider } from "../src/i18n/provider"
import { ThemeProvider } from "../src/theme/provider"

const mocks = vi.hoisted(() => ({ artifact: vi.fn() }))

vi.mock("../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/client")>()
  return { ...actual, api: mocks }
})

const ID = "a".repeat(64)
const URL = `https://artifacts.example.test/a/${ID}?exp=4070908800&sig=${"s".repeat(43)}`
const LATER = "2099-01-01T00:00:00.000Z"

/** The bridge accepts one result per 500 ms; real waits keep userEvent honest. */
const RESULT_WINDOW_MS = 520

function artifact(): ArtifactResponse {
  return {
    id: ID,
    title: "Interest calculator",
    bytes: 4096,
    createdAt: "2026-11-18T12:00:00.000Z",
    url: URL,
    expiresAt: LATER,
  }
}

interface FrameWindow {
  postMessage: ReturnType<typeof vi.fn>
}

let frameWindow: FrameWindow
let nonce: string

function providers(children: ReactNode) {
  return (
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale="en">
        <MemoryRouter initialEntries={[`/artifacts/${ID}`]}>
          <Routes>
            <Route path="/artifacts/:id" element={children} />
            <Route path="/artifacts" element={<p>artifact list</p>} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </ThemeProvider>
  )
}

/**
 * Mounts the viewer, stubs the frame's window like the bridge tests do and
 * completes the handshake, so `postResult` talks through the real bridge.
 */
async function openViewer(onArtifactResult?: (result: ArtifactResult) => void) {
  render(providers(<ArtifactViewer onArtifactResult={onArtifactResult} />))
  const frame = (await screen.findByTestId("artifact-frame")) as HTMLIFrameElement
  const posted: unknown[][] = []
  frameWindow = {
    postMessage: vi.fn((message: unknown, target: string) => {
      posted.push([message, target])
    }),
  }
  Object.defineProperty(frame, "contentWindow", { configurable: true, value: frameWindow })
  fireEvent.load(frame)
  const init = posted[0]?.[0] as Record<string, unknown>
  expect(init).toMatchObject({ type: "artifact:init" })
  nonce = String(init.nonce)
  await act(async () => {})
  return frame
}

function post(data: Record<string, unknown>): void {
  const event = new MessageEvent("message", { data })
  Object.defineProperty(event, "source", { configurable: true, value: frameWindow })
  window.dispatchEvent(event)
}

async function postResult(payload: ArtifactResult): Promise<void> {
  await act(async () => {
    post({ type: "artifact:result", nonce, ...payload })
  })
}

/** Wait past the bridge's 500 ms window so the next result is accepted. */
async function nextResultWindow(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, RESULT_WINDOW_MS))
  })
}

beforeEach(() => {
  mocks.artifact.mockReset()
  mocks.artifact.mockResolvedValue(artifact())
})

describe("artifact draft panel", () => {
  it("shows no panel before the artifact posts a result", async () => {
    await openViewer()

    expect(screen.getByTestId("artifact-frame")).toBeInTheDocument()
    expect(screen.queryByTestId("artifact-draft")).toBeNull()
    expect(screen.queryByRole("region", { name: "Artifact result" })).toBeNull()
  })

  it("renders a result as an editable labelled draft with its data as JSON", async () => {
    await openViewer()
    await postResult({ title: "Interest", text: "12.5 % after 3 years", data: { rate: 0.05 } })

    const region = screen.getByRole("region", { name: "Artifact result" })
    expect(region).toBeInTheDocument()
    expect(screen.getByLabelText("Title")).toHaveValue("Interest")
    expect(screen.getByLabelText("Text")).toHaveValue("12.5 % after 3 years")
    expect(screen.getByTestId("artifact-draft-data")).toHaveTextContent('"rate": 0.05')
    expect(
      screen.getByText("Structured data from the artifact, shown as JSON — not a document."),
    ).toBeInTheDocument()
    // There is no session on this route, so nothing offers to send the draft.
    expect(screen.queryByRole("button", { name: /send/i })).toBeNull()
  })

  it("prefills a generic title when the result carries none", async () => {
    await openViewer()
    await postResult({ text: "only text" })

    expect(screen.getByLabelText("Title")).toHaveValue("Result from this artifact")
    expect(screen.getByLabelText("Text")).toHaveValue("only text")
    expect(screen.queryByTestId("artifact-draft-data")).toBeNull()
  })

  it("follows the artifact while the draft is untouched", async () => {
    await openViewer()
    await postResult({ title: "First", text: "one" })
    await nextResultWindow()
    await postResult({ title: "Second", text: "two" })

    expect(screen.getByLabelText("Title")).toHaveValue("Second")
    expect(screen.getByLabelText("Text")).toHaveValue("two")
    expect(screen.queryByTestId("artifact-draft-new")).toBeNull()
  })

  it("keeps an edited draft and only replaces it after the offer is clicked", async () => {
    const user = userEvent.setup()
    await openViewer()
    await postResult({ title: "First", text: "one" })

    const text = screen.getByLabelText("Text")
    await user.clear(text)
    await user.type(text, "my own words")

    await nextResultWindow()
    await postResult({ title: "Second", text: "two" })

    // The edit survives; the new result is only offered.
    expect(screen.getByLabelText("Text")).toHaveValue("my own words")
    expect(screen.getByLabelText("Title")).toHaveValue("First")
    const offer = screen.getByTestId("artifact-draft-new")
    expect(offer).toHaveTextContent("New result available")

    await user.click(offer)

    expect(screen.getByLabelText("Title")).toHaveValue("Second")
    expect(screen.getByLabelText("Text")).toHaveValue("two")
    expect(screen.queryByTestId("artifact-draft-new")).toBeNull()
  })

  it("copies the draft and acknowledges it briefly", async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText, readText: vi.fn(async () => "") },
    })
    await openViewer()
    await postResult({ title: "Rate", text: "12.5 %" })

    await user.click(screen.getByTestId("artifact-draft-copy"))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Rate\n\n12.5 %"))
    expect(screen.getByTestId("artifact-draft-copy")).toHaveTextContent(/^Copied$/)
    await waitFor(
      () => expect(screen.getByTestId("artifact-draft-copy")).toHaveTextContent(/^Copy$/),
      { timeout: 4_000 },
    )
  })

  it("dismisses the draft and shows the next result again", async () => {
    const user = userEvent.setup()
    await openViewer()
    await postResult({ title: "First", text: "one" })

    await user.click(screen.getByTestId("artifact-draft-dismiss"))
    expect(screen.queryByTestId("artifact-draft")).toBeNull()

    await nextResultWindow()
    await postResult({ title: "First", text: "one" })

    expect(screen.getByTestId("artifact-draft")).toBeInTheDocument()
    expect(screen.getByLabelText("Text")).toHaveValue("one")
  })

  it("keeps an HTML-ish payload as literal text", async () => {
    const payload = '<img src=x onerror="alert(1)">'
    await openViewer()
    await postResult({ title: payload, text: payload })

    expect(screen.getByLabelText("Title")).toHaveValue(payload)
    expect(screen.getByLabelText("Text")).toHaveValue(payload)
    // Literal text in a value, never parsed: no element, no handler attribute.
    expect(document.querySelector("img")).toBeNull()
    expect(document.querySelector("[onerror]")).toBeNull()
    expect(screen.getByTestId("artifact-draft-text").textContent).toBe(payload)
  })

  it("does not take focus when the draft appears", async () => {
    const user = userEvent.setup()
    await openViewer()
    await user.tab()
    const focused = document.activeElement
    expect(focused).toBe(screen.getByTestId("artifact-back"))

    await postResult({ title: "Interest", text: "12.5 %" })

    expect(screen.getByTestId("artifact-draft")).toBeInTheDocument()
    expect(document.activeElement).toBe(focused)
  })

  it("feeds the callback and the panel from one result path", async () => {
    const results: ArtifactResult[] = []
    await openViewer((result) => results.push(result))
    await postResult({ title: "T", text: "ok", data: { n: 1 } })

    expect(results).toEqual([{ title: "T", text: "ok", data: { n: 1 } }])
    expect(screen.getByLabelText("Title")).toHaveValue("T")
    expect(screen.getByLabelText("Text")).toHaveValue("ok")
  })
})
