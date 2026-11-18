import { fireEvent, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  DICTATION,
  fetchMock,
  installMedia,
  renderComposer,
  startRecording,
  transcription,
  uninstallMedia,
} from "./dictation-harness"

const { cache, session, createLocalSession } = vi.hoisted(() => {
  const cache = {
    prepareLocalModel: vi.fn(async () => null),
    isLocalModelCached: vi.fn(async () => false),
    writeConsent: vi.fn(),
    deleteLocalModel: vi.fn(async () => undefined),
  }
  const session = {
    load: vi.fn(async () => undefined),
    transcribe: vi.fn(async () => ({ text: "Lokales Diktat", durationMs: 12 })),
    cancel: vi.fn(),
  }
  const createLocalSession = vi.fn(() => session)
  return { cache, session, createLocalSession }
})
vi.mock("../src/dictation/local-cache", () => ({ ...cache }))
vi.mock("../src/dictation/local-transcriber", () => ({
  createLocalSession,
  LocalFailure: class LocalFailure extends Error {},
}))

const LOCAL = {
  ...DICTATION,
  local: { available: true, model: "whisper-base" },
  server: { available: false },
}

beforeEach(() => {
  fetchMock.mockReset()
  installMedia()
  cache.prepareLocalModel.mockClear()
  cache.isLocalModelCached.mockClear()
  cache.writeConsent.mockClear()
  cache.deleteLocalModel.mockClear()
  createLocalSession.mockClear()
  session.load.mockClear()
  session.transcribe.mockClear()
  session.cancel.mockClear()
  session.transcribe.mockResolvedValue({ text: "Lokales Diktat", durationMs: 12 })
})

afterEach(() => uninstallMedia())

describe("on-device dictation consent", () => {
  it("asks before any model byte is requested", async () => {
    const user = userEvent.setup()
    renderComposer(LOCAL)

    await user.click(screen.getByTestId("dictation"))

    expect(await screen.findByTestId("dictation-consent")).toBeVisible()
    expect(screen.getByTestId("dictation-consent-download")).toHaveTextContent("Download")
    expect(screen.queryByTestId("dictation-consent-server")).toBeNull()
    expect(createLocalSession).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("starts the download only after explicit consent", async () => {
    const user = userEvent.setup()
    renderComposer(LOCAL)
    await user.click(screen.getByTestId("dictation"))
    await screen.findByTestId("dictation-consent")

    await user.click(screen.getByTestId("dictation-consent-download"))

    expect(createLocalSession).toHaveBeenCalledTimes(1)
    expect(session.load).toHaveBeenCalledTimes(1)
    expect(cache.writeConsent).toHaveBeenCalledWith("accepted")
    await waitFor(() => expect(screen.queryByTestId("dictation-consent")).toBeNull())
  })

  it("remembers a declined consent and never asks twice", async () => {
    const user = userEvent.setup()
    renderComposer(LOCAL)
    await user.click(screen.getByTestId("dictation"))
    await screen.findByTestId("dictation-consent")

    await user.click(screen.getByTestId("dictation-consent-cancel"))

    expect(cache.writeConsent).toHaveBeenCalledWith("declined")
    expect(screen.queryByTestId("dictation-consent")).toBeNull()
    await user.click(screen.getByTestId("dictation"))
    expect(screen.queryByTestId("dictation-consent")).toBeNull()
    expect(createLocalSession).not.toHaveBeenCalled()
  })

  it("offers the server action only when a server path is configured", async () => {
    const user = userEvent.setup()
    renderComposer({ ...LOCAL, server: { available: true } })
    await user.click(screen.getByTestId("dictation"))
    await screen.findByTestId("dictation-consent")
    const button = screen.getByTestId("dictation-consent-server")
    expect(button).toHaveTextContent("Use server STT")
    await user.click(button)
    expect(cache.writeConsent).toHaveBeenCalledWith("server")
    expect(createLocalSession).not.toHaveBeenCalled()
  })

  it("falls back to /api/transcribe when the local model fails", async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue(transcription("Server Diktat"))
    session.transcribe.mockRejectedValueOnce({ code: "model_unavailable" })
    const { textarea } = renderComposer({ ...LOCAL, server: { available: true } })
    await user.click(screen.getByTestId("dictation"))
    await user.click(await screen.findByTestId("dictation-consent-download"))
    await waitFor(() => expect(screen.queryByTestId("dictation-consent")).toBeNull())

    await startRecording(user)
    await user.click(screen.getByTestId("dictation-stop"))

    await waitFor(() => expect(textarea.value).toBe("Server Diktat"))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/transcribe?language=en")
    expect(screen.getByTestId("dictation-path")).toHaveTextContent("via server")
  })

  it("shows a clear error when no server path can take over", async () => {
    const user = userEvent.setup()
    session.transcribe.mockRejectedValueOnce({ code: "out_of_memory" })
    renderComposer(LOCAL)
    await user.click(screen.getByTestId("dictation"))
    await user.click(await screen.findByTestId("dictation-consent-download"))
    await waitFor(() => expect(screen.queryByTestId("dictation-consent")).toBeNull())

    await startRecording(user)
    await user.click(screen.getByTestId("dictation-stop"))

    expect(await screen.findByTestId("dictation-error")).toHaveTextContent("not enough memory")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("deletes the cache and resets consent", async () => {
    renderComposer(LOCAL)
    fireEvent.click(screen.getByTestId("dictation-delete-model"))
    await waitFor(() => expect(cache.deleteLocalModel).toHaveBeenCalledTimes(1))
  })
})
