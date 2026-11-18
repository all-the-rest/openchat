import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Composer } from "../src/chat/Composer"
import { I18nProvider } from "../src/i18n/provider"
import {
  DICTATION,
  FakeMediaRecorder,
  apiFailure,
  fetchMock,
  getUserMedia,
  installMedia,
  renderComposer,
  startRecording,
  transcription,
  uninstallMedia,
} from "./dictation-harness"

beforeEach(() => {
  fetchMock.mockReset()
  installMedia()
})

afterEach(() => {
  uninstallMedia()
})

describe("dictation control", () => {
  it("hides the microphone when dictation is disabled", () => {
    renderComposer({ ...DICTATION, enabled: false })

    expect(screen.queryByTestId("dictation")).toBeNull()
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it("gives the idle microphone a button surface (UI-8)", () => {
    renderComposer()

    const mic = screen.getByTestId("dictation")
    // The send control beside it is a filled disc; a bare glyph reads as
    // decoration. Recording switches back to a ghost surface.
    expect(mic.className).toContain("btn-soft")
    expect(mic.className).not.toContain("btn-ghost")
  })

  it("never requests the microphone on mount", () => {
    renderComposer()

    expect(screen.getByTestId("dictation")).toBeInTheDocument()
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it("reads the capability from /api/info when no override is given", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ dictation: { enabled: true, maxSeconds: 60, maxBytes: 4096 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
    render(
      <I18nProvider initialLocale="en">
        <Composer onSend={vi.fn()} onStop={vi.fn()} running={false} />
      </I18nProvider>,
    )

    expect(await screen.findByTestId("dictation")).toBeInTheDocument()
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/info")
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it("explains a denied permission and sends no request", async () => {
    const user = userEvent.setup()
    getUserMedia.mockRejectedValue(Object.assign(new Error("denied"), { name: "NotAllowedError" }))
    const { textarea } = renderComposer()

    await user.click(screen.getByTestId("dictation"))

    const alert = await screen.findByTestId("dictation-error")
    expect(alert).toHaveTextContent("Microphone access was denied")
    expect(fetchMock).not.toHaveBeenCalled()
    expect(textarea.value).toBe("")
    expect(screen.queryByTestId("dictation-pill")).toBeNull()
  })

  it("fails loudly when no supported recording format exists", async () => {
    const user = userEvent.setup()
    FakeMediaRecorder.isTypeSupported.mockReturnValue(false)
    renderComposer()

    await user.click(screen.getByTestId("dictation"))

    expect(await screen.findByTestId("dictation-error")).toHaveTextContent(
      "cannot record audio in a format",
    )
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("cancels without a request and leaves the draft alone", async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue(transcription("unused"))
    const { textarea } = renderComposer(DICTATION, "keep this")

    await startRecording(user)
    await user.click(screen.getByTestId("dictation-cancel"))

    expect(screen.queryByTestId("dictation-pill")).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(textarea.value).toBe("keep this")
  })

  it("transcribes on stop, inserts at the caret and keeps the composer focused", async () => {
    const user = userEvent.setup()
    let resolveTranscription: (response: Response) => void = () => undefined
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveTranscription = resolve
        }),
    )
    const { textarea } = renderComposer(DICTATION, "Dear , please review.")
    textarea.setSelectionRange(5, 5)

    await startRecording(user)
    await user.click(screen.getByTestId("dictation-stop"))

    // The recording format is picked from the browser, the request uses the base type.
    expect(FakeMediaRecorder.last().mimeType).toBe("audio/webm;codecs=opus")
    expect(await screen.findByTestId("dictation-busy")).toHaveTextContent("Transcribing…")

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/transcribe?language=en")
    expect(new Headers(init.headers).get("content-type")).toBe("audio/webm")
    expect(init.body).toBeInstanceOf(Blob)
    expect((init.body as Blob).type).toBe("audio/webm")

    await act(async () => {
      resolveTranscription(transcription("Ada"))
    })

    await waitFor(() => expect(textarea.value).toBe("Dear Ada, please review."))
    expect(textarea).toHaveFocus()
    expect(textarea.selectionStart).toBe(8)
    expect(screen.queryByTestId("dictation-busy")).toBeNull()
  })

  it("reports an empty transcript and keeps the draft", async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue(transcription("   "))
    const { textarea } = renderComposer(DICTATION, "keep me")

    await startRecording(user)
    await user.click(screen.getByTestId("dictation-stop"))

    const alert = await screen.findByTestId("dictation-error")
    expect(alert).toHaveTextContent("No speech was recognized")
    expect(textarea.value).toBe("keep me")
  })

  it("keeps the recording and retries after a 503", async () => {
    const user = userEvent.setup()
    fetchMock
      .mockResolvedValueOnce(apiFailure("stt_unavailable", 503))
      .mockResolvedValueOnce(transcription("hello there"))
    const { textarea } = renderComposer(DICTATION, "keep me ")

    await startRecording(user)
    await user.click(screen.getByTestId("dictation-stop"))

    const alert = await screen.findByTestId("dictation-error")
    expect(alert).toHaveTextContent("The transcription service is unavailable")
    expect(textarea.value).toBe("keep me ")
    expect(screen.getByTestId("dictation-retry")).toBeInTheDocument()

    await user.click(screen.getByTestId("dictation-retry"))

    await waitFor(() => expect(textarea.value).toBe("keep me hello there"))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId("dictation-error")).toBeNull()
  })

  it("reports a timeout as recoverable", async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue(apiFailure("stt_timeout", 504))
    const { textarea } = renderComposer()

    await startRecording(user)
    await user.click(screen.getByTestId("dictation-stop"))

    const alert = await screen.findByTestId("dictation-error")
    expect(alert).toHaveTextContent("timed out")
    expect(screen.getByTestId("dictation-retry")).toBeInTheDocument()
    expect(textarea.value).toBe("")
  })

  it("auto-stops before the blob crosses the byte limit", async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue(transcription("cut here"))
    const { textarea } = renderComposer({ ...DICTATION, maxBytes: 10 })

    const recorder = await startRecording(user)
    act(() => recorder.emit(6))
    act(() => recorder.emit(6))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId("dictation-notice")).toHaveTextContent(
      "Recording stopped at the 10 B limit.",
    )
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.body as Blob).size).toBeLessThanOrEqual(10)
    await waitFor(() => expect(textarea.value).toBe("cut here"))
  })

  it("stops the capture when a held microphone is released", async () => {
    fetchMock.mockResolvedValue(transcription("held transcript"))
    const { textarea } = renderComposer()
    const mic = screen.getByTestId("dictation")

    fireEvent.pointerDown(mic, { button: 0, pointerId: 1 })
    await screen.findByTestId("dictation-pill")
    await waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1))

    // Longer than the hold threshold: release ends capture, like a walkie-talkie.
    await new Promise((resolve) => setTimeout(resolve, 400))
    fireEvent.pointerUp(mic, { pointerId: 1 })
    // A real long press still emits its click; it must not restart the capture.
    fireEvent.click(mic, { detail: 1 })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(textarea.value).toBe("held transcript"))
    expect(screen.queryByTestId("dictation-pill")).toBeNull()
  })

  it("keeps recording after a short press and stops on the next click", async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue(transcription("hands free"))
    const { textarea } = renderComposer()
    const mic = screen.getByTestId("dictation")

    fireEvent.pointerDown(mic, { button: 0, pointerId: 1 })
    await screen.findByTestId("dictation-pill")
    fireEvent.pointerUp(mic, { pointerId: 1 })
    // The click that belongs to the starting press must not stop it.
    fireEvent.click(mic, { detail: 1 })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByTestId("dictation-pill")).toBeInTheDocument()

    await user.click(mic)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(textarea.value).toBe("hands free"))
  })

  it("records again on retry when the service reports an empty transcript", async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValueOnce(apiFailure("empty_transcript", 422))
    const { textarea } = renderComposer(DICTATION, "keep me ")

    await startRecording(user)
    await user.click(screen.getByTestId("dictation-stop"))

    const alert = await screen.findByTestId("dictation-error")
    expect(alert).toHaveTextContent("No speech was recognized")

    fetchMock.mockResolvedValueOnce(transcription("second attempt"))
    await user.click(screen.getByTestId("dictation-retry"))
    await screen.findByTestId("dictation-pill")
    // Retry starts a new capture instead of resending audio that has no words.
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await user.click(screen.getByTestId("dictation-stop"))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(textarea.value).toBe("keep me second attempt"))
  })

  it("auto-stops at the time limit and notes the limit", async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue(transcription("time is up"))
    const { textarea } = renderComposer({ ...DICTATION, maxSeconds: 1 })

    await startRecording(user)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 3000 })
    expect(screen.getByTestId("dictation-notice")).toHaveTextContent(
      "Recording stopped at the 0:01 limit.",
    )
    await waitFor(() => expect(textarea.value).toBe("time is up"))
  })
})
