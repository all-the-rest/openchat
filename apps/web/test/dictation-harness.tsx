import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { expect, vi } from "vitest"
import type { DictationInfo } from "@openchat/contracts"
import { Composer } from "../src/chat/Composer"
import { I18nProvider } from "../src/i18n/provider"

export const DICTATION: DictationInfo = {
  enabled: true,
  maxSeconds: 120,
  maxBytes: 25 * 1024 * 1024,
}

export const getUserMedia = vi.fn()
export const fetchMock = vi.fn()

export const tracks: Array<{ stop: ReturnType<typeof vi.fn> }> = []

export function createStream(): MediaStream {
  const track = { stop: vi.fn(), kind: "audio" }
  tracks.push(track)
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream
}

class FakeAnalyserNode {
  fftSize = 256

  getByteTimeDomainData(samples: Uint8Array): void {
    samples.fill(128)
  }
}

class FakeAudioContext {
  createAnalyser(): FakeAnalyserNode {
    return new FakeAnalyserNode()
  }

  createMediaStreamSource(): { connect(): void; disconnect(): void } {
    return { connect: vi.fn(), disconnect: vi.fn() }
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

/** Browser recorder double; `stop()` emits a chunk and the stop event. */
export class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  static isTypeSupported = vi.fn(
    (type: string) => type.startsWith("audio/webm") || type === "audio/mp4",
  )

  state: "inactive" | "recording" = "inactive"
  mimeType: string
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null

  constructor(
    readonly stream: MediaStream,
    options?: { mimeType?: string },
  ) {
    this.mimeType = options?.mimeType ?? ""
    FakeMediaRecorder.instances.push(this)
  }

  start(): void {
    this.state = "recording"
  }

  stop(): void {
    if (this.state === "inactive") return
    this.state = "inactive"
    this.emit(6)
    this.onstop?.()
  }

  emit(size = 6): void {
    this.ondataavailable?.({
      data: new Blob([new Uint8Array(size)], { type: this.mimeType }),
    })
  }

  static last(): FakeMediaRecorder {
    const instance = FakeMediaRecorder.instances.at(-1)
    if (!instance) throw new Error("no MediaRecorder was created")
    return instance
  }
}

export function installMedia(): void {
  FakeMediaRecorder.instances = []
  FakeMediaRecorder.isTypeSupported = vi.fn(
    (type: string) => type.startsWith("audio/webm") || type === "audio/mp4",
  )
  tracks.length = 0
  getUserMedia.mockReset()
  getUserMedia.mockImplementation(async () => createStream())
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  })
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder)
  vi.stubGlobal("AudioContext", FakeAudioContext)
  vi.stubGlobal("fetch", fetchMock)
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(() => "blob:dictation"),
  })
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  })
}

export function uninstallMedia(): void {
  vi.unstubAllGlobals()
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: undefined,
  })
}

export function transcription(text: string, durationMs = 1200): Response {
  return new Response(JSON.stringify({ text, durationMs }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

export function apiFailure(code: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message: code } }), {
    status,
    headers: { "content-type": "application/json" },
  })
}

export function renderComposer(
  dictation: DictationInfo | null = DICTATION,
  draft = "",
): { textarea: HTMLTextAreaElement; onSend: ReturnType<typeof vi.fn> } {
  const onSend = vi.fn(async (_text: string) => undefined)
  render(
    <I18nProvider initialLocale="en">
      <Composer onSend={onSend} onStop={vi.fn()} running={false} dictation={dictation} />
    </I18nProvider>,
  )
  const textarea = screen.getByTestId("composer") as HTMLTextAreaElement
  if (draft) fireEvent.change(textarea, { target: { value: draft } })
  return { textarea, onSend }
}

/** Starts a recording and waits until capture actually runs. */
export async function startRecording(user: {
  click(element: HTMLElement): Promise<void>
}): Promise<FakeMediaRecorder> {
  await user.click(screen.getByTestId("dictation"))
  await screen.findByTestId("dictation-pill")
  await waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1))
  await screen.findByTestId("dictation-stop")
  return FakeMediaRecorder.last()
}
