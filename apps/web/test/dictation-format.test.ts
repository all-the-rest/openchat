import { afterEach, describe, expect, it, vi } from "vitest"
import { baseMimeType, formatBytes, formatDuration, pickMimeType } from "../src/dictation/format"

function stubRecorder(supported: string[]): void {
  class Recorder {
    static isTypeSupported(type: string): boolean {
      return supported.includes(type)
    }
  }
  vi.stubGlobal("MediaRecorder", Recorder)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("dictation formats", () => {
  it("prefers webm/opus, then mp4, then ogg", () => {
    stubRecorder(["audio/webm;codecs=opus", "audio/mp4", "audio/ogg"])
    expect(pickMimeType()).toBe("audio/webm;codecs=opus")

    stubRecorder(["audio/mp4", "audio/ogg"])
    expect(pickMimeType()).toBe("audio/mp4")

    stubRecorder(["audio/ogg"])
    expect(pickMimeType()).toBe("audio/ogg")

    stubRecorder([])
    expect(pickMimeType()).toBeNull()
  })

  it("drops the codec parameter for the request content type", () => {
    expect(baseMimeType("audio/webm;codecs=opus")).toBe("audio/webm")
    expect(baseMimeType("audio/mp4")).toBe("audio/mp4")
  })

  it("formats the recording clock as m:ss", () => {
    expect(formatDuration(0)).toBe("0:00")
    expect(formatDuration(9_400)).toBe("0:09")
    expect(formatDuration(61_000)).toBe("1:01")
    expect(formatDuration(120_000)).toBe("2:00")
  })

  it("rounds byte limits for the limit note", () => {
    expect(formatBytes(10)).toBe("10 B")
    expect(formatBytes(2_048)).toBe("2 KB")
    expect(formatBytes(25 * 1024 * 1024)).toBe("25 MB")
  })
})
