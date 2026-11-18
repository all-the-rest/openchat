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

function frames(): { frame: HTMLIFrameElement; window: FrameWindow; posted: unknown[][] } {
  const frame = screen.getByTestId("artifact-frame") as HTMLIFrameElement
  const posted: unknown[][] = []
  const window: FrameWindow = {
    postMessage: vi.fn((message: unknown, target: string) => {
      posted.push([message, target])
    }),
  }
  Object.defineProperty(frame, "contentWindow", { configurable: true, value: window })
  return { frame, window, posted }
}

function post(data: unknown, source: unknown): void {
  const event = new MessageEvent("message", { data })
  Object.defineProperty(event, "source", { configurable: true, value: source })
  window.dispatchEvent(event)
}

function providers(children: ReactNode) {
  return (
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale="en">
        <MemoryRouter initialEntries={[`/artifacts/${ID}`]}>
          <Routes>
            <Route path="/artifacts/:id" element={children} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </ThemeProvider>
  )
}

async function openViewer(onArtifactResult?: (result: ArtifactResult) => void) {
  render(providers(<ArtifactViewer onArtifactResult={onArtifactResult} />))
  const frame = await screen.findByTestId("artifact-frame")
  return frame as HTMLIFrameElement
}

function initMessage(posted: unknown[][]): Record<string, unknown> {
  const first = posted[0]?.[0]
  expect(first).toMatchObject({ type: "artifact:init" })
  return first as Record<string, unknown>
}

beforeEach(() => {
  mocks.artifact.mockReset()
  mocks.artifact.mockResolvedValue(artifact())
})

afterEach(() => {
  vi.useRealTimers()
})

describe("artifact bridge", () => {
  it("posts artifact:init on load with the id, theme, locale and a nonce", async () => {
    await openViewer()
    const { posted } = frames()
    fireEvent.load(screen.getByTestId("artifact-frame"))

    const init = initMessage(posted)
    expect(init).toEqual({
      type: "artifact:init",
      id: ID,
      nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
      theme: "dark",
      locale: "en",
    })
    // targetOrigin "*": the sandboxed frame's origin is the string "null".
    expect(posted[0]?.[1]).toBe("*")
  })

  it("reposts the same nonce twice and stops after a ready", async () => {
    await openViewer()
    const { window, posted } = frames()
    vi.useFakeTimers()
    fireEvent.load(screen.getByTestId("artifact-frame"))
    const first = initMessage(posted)

    act(() => vi.advanceTimersByTime(1_000))
    expect(posted).toHaveLength(2)
    act(() => vi.advanceTimersByTime(1_000))
    expect(posted).toHaveLength(3)
    expect(initMessage(posted).nonce).toBe(first.nonce)
    act(() => vi.advanceTimersByTime(5_000))
    expect(posted).toHaveLength(3)

    // A frame that answers after the second repost still completes the
    // handshake; no further repost follows.
    post({ type: "artifact:ready", nonce: first.nonce }, window)
    act(() => vi.advanceTimersByTime(5_000))
    expect(posted).toHaveLength(3)
  })

  it("clamps artifact:resize to integer pixels in 80…4000 and sizes the frame", async () => {
    await openViewer()
    const { frame, window, posted } = frames()
    fireEvent.load(frame)
    const { nonce } = initMessage(posted)

    post({ type: "artifact:resize", nonce, height: 10 }, window)
    await waitFor(() => expect(frame.style.height).toBe("80px"))

    post({ type: "artifact:resize", nonce, height: 9_000 }, window)
    await waitFor(() => expect(frame.style.height).toBe("4000px"))

    post({ type: "artifact:resize", nonce, height: 321.6 }, window)
    await waitFor(() => expect(frame.style.height).toBe("322px"))
  })

  it("ignores messages from a foreign source and with a wrong nonce", async () => {
    const results: ArtifactResult[] = []
    await openViewer((result) => results.push(result))
    const { frame, window, posted } = frames()
    fireEvent.load(frame)
    const { nonce } = initMessage(posted)

    post({ type: "artifact:resize", nonce, height: 500 }, { other: true })
    post({ type: "artifact:result", nonce, text: "foreign" }, { other: true })
    post({ type: "artifact:resize", nonce: "wrong", height: 600 }, window)
    post({ type: "artifact:result", nonce: "wrong", text: "wrong nonce" }, window)

    await act(async () => {})
    expect(frame.style.height).toBe("")
    expect(results).toEqual([])
  })

  it("accepts a small result and drops one over 64 KiB", async () => {
    const results: ArtifactResult[] = []
    await openViewer((result) => results.push(result))
    const { frame, window, posted } = frames()
    vi.useFakeTimers()
    fireEvent.load(frame)
    const { nonce } = initMessage(posted)

    // The oversized result is refused by the size check before the rate limit.
    post({ type: "artifact:result", nonce, text: "x".repeat(65 * 1024) }, window)
    act(() => vi.advanceTimersByTime(600))
    post({ type: "artifact:result", nonce, title: "T", text: "ok", data: { n: 1 } }, window)

    expect(results).toEqual([{ title: "T", text: "ok", data: { n: 1 } }])
  })

  it("rate-limits a 10 Hz result stream to one per 500 ms", async () => {
    const results: ArtifactResult[] = []
    await openViewer((result) => results.push(result))
    const { frame, window, posted } = frames()
    vi.useFakeTimers()
    fireEvent.load(frame)
    const { nonce } = initMessage(posted)

    for (let index = 0; index < 10; index += 1) {
      post({ type: "artifact:result", nonce, text: `tick ${index}` }, window)
      act(() => vi.advanceTimersByTime(100))
    }
    // t=0 accepted; t=500 is the first message past the 500 ms window.
    expect(results.map((result) => result.text)).toEqual(["tick 0", "tick 5"])

    act(() => vi.advanceTimersByTime(500))
    post({ type: "artifact:result", nonce, text: "later" }, window)
    expect(results.map((result) => result.text)).toEqual(["tick 0", "tick 5", "later"])
  })

  it("hands a result to the draft callback and never injects its text", async () => {
    const results: ArtifactResult[] = []
    await openViewer((result) => results.push(result))
    const { frame, window, posted } = frames()
    fireEvent.load(frame)
    const { nonce } = initMessage(posted)

    post({ type: "artifact:result", nonce, text: "<b>not markup</b>" }, window)
    await act(async () => {})

    expect(results).toEqual([{ text: "<b>not markup</b>" }])
    expect(screen.queryByText("<b>not markup</b>")).toBeNull()
    expect(document.querySelector("b")).toBeNull()
  })

  it("asks a ready artifact to reset over the bridge without remounting", async () => {
    const user = userEvent.setup()
    await openViewer()
    const { frame, window, posted } = frames()
    fireEvent.load(frame)
    const { nonce } = initMessage(posted)
    post({ type: "artifact:ready", nonce }, window)
    await act(async () => {})

    await user.click(screen.getByTestId("artifact-reload"))

    expect(posted.map((entry) => (entry[0] as Record<string, unknown>).type)).toEqual([
      "artifact:init",
      "artifact:reset",
    ])
    expect(posted[1]?.[0]).toEqual({ type: "artifact:reset", nonce })
    expect(screen.getByTestId("artifact-frame")).toBe(frame)
    expect(mocks.artifact).toHaveBeenCalledTimes(1)

    // The shim reloads its document; the resulting load starts a new handshake
    // with the same nonce.
    fireEvent.load(frame)
    expect(posted.filter((entry) => (entry[0] as { type?: string }).type === "artifact:init"))
      .toHaveLength(2)
  })

  it("resets with the same signed URL without minting a new one", async () => {
    const user = userEvent.setup()
    await openViewer()
    const before = frames()
    fireEvent.load(before.frame)
    const first = initMessage(before.posted)

    await user.click(screen.getByTestId("artifact-reload"))

    const after = frames()
    expect(after.frame).not.toBe(before.frame)
    expect(after.frame).toHaveAttribute("src", URL)
    expect(mocks.artifact).toHaveBeenCalledTimes(1)

    // The new frame gets a fresh nonce; the previous one can no longer talk
    // to this viewer.
    fireEvent.load(after.frame)
    const second = initMessage(after.posted)
    expect(second.nonce).not.toBe(first.nonce)

    const late = { type: "artifact:resize", nonce: first.nonce, height: 500 }
    post(late, after.window)
    await act(async () => {})
    expect(after.frame.style.height).toBe("")
  })

  it("uses the documented iframe sandbox with no top navigation or same-origin", async () => {
    const frame = await openViewer()
    expect(frame).toHaveAttribute("sandbox", "allow-scripts")
    const sandbox = frame.getAttribute("sandbox") ?? ""
    expect(sandbox).not.toContain("allow-same-origin")
    expect(sandbox).not.toContain("allow-top-navigation")
    expect(sandbox).not.toContain("allow-popups")
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer")
  })

  it("drops unknown message types such as an undocumented artifact:error", async () => {
    const results: ArtifactResult[] = []
    await openViewer((result) => results.push(result))
    const { frame, window, posted } = frames()
    fireEvent.load(frame)
    const { nonce } = initMessage(posted)

    post({ type: "artifact:error", nonce, message: "boom" }, window)
    await act(async () => {})
    expect(results).toEqual([])
    expect(frame.style.height).toBe("")
  })
})
