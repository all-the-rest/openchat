import { fireEvent, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  DICTATION,
  FakeMediaRecorder,
  fetchMock,
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

describe("dictation keyboard", () => {
  it("cancels a recording with Escape and sends nothing", async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue(transcription("never sent"))
    const { textarea } = renderComposer(DICTATION, "draft")

    await startRecording(user)
    fireEvent.keyDown(window, { key: "Escape" })

    expect(screen.queryByTestId("dictation-pill")).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(textarea.value).toBe("draft")
  })

  it("toggles recording with Enter while the button is focused", async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue(transcription("by keyboard"))
    const { textarea } = renderComposer()
    const button = screen.getByTestId("dictation")
    button.focus()

    await user.keyboard("{Enter}")
    await screen.findByTestId("dictation-pill")
    await waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1))
    await screen.findByTestId("dictation-stop")

    await user.keyboard("{Enter}")

    await waitFor(() => expect(textarea.value).toBe("by keyboard"))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("toggles recording with Space while the button is focused", async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue(transcription("space works"))
    const { textarea } = renderComposer()
    const button = screen.getByTestId("dictation")
    button.focus()

    await user.keyboard("{Space}")
    await screen.findByTestId("dictation-pill")
    await waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1))
    await screen.findByTestId("dictation-stop")

    await user.keyboard("{Space}")

    await waitFor(() => expect(textarea.value).toBe("space works"))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
