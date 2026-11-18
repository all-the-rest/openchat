import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { Composer } from "../src/chat/Composer"
import { I18nProvider } from "../src/i18n/provider"

function renderComposer(onSend = vi.fn(async (_text: string) => undefined), onStop = vi.fn()) {
  render(
    <I18nProvider initialLocale="en">
      <Composer onSend={onSend} onStop={onStop} running={false} />
    </I18nProvider>,
  )
  return { onSend, onStop }
}

describe("Composer", () => {
  it("disables sending while empty", () => {
    renderComposer()

    expect(screen.getByTestId("send")).toBeDisabled()
    expect(screen.queryByTestId("stop")).not.toBeInTheDocument()
  })

  it("sends on Enter and clears the field", async () => {
    const user = userEvent.setup()
    const { onSend } = renderComposer()
    const textarea = screen.getByTestId("composer")

    await user.type(textarea, "Hello there")
    expect(screen.getByTestId("send")).toBeEnabled()

    await user.type(textarea, "{Enter}")

    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Hello there"))
    expect((textarea as HTMLTextAreaElement).value).toBe("")
  })

  it("inserts a newline on Shift+Enter and does not send", async () => {
    const user = userEvent.setup()
    const { onSend } = renderComposer()
    const textarea = screen.getByTestId("composer")

    await user.type(textarea, "line one")
    await user.type(textarea, "{Shift>}{Enter}{/Shift}")
    await user.type(textarea, "line two")

    expect(onSend).not.toHaveBeenCalled()
    expect((textarea as HTMLTextAreaElement).value).toBe("line one\nline two")
  })

  it("keeps the draft when sending fails", async () => {
    const user = userEvent.setup()
    const onSend = vi.fn(async () => {
      throw new Error("network down")
    })
    renderComposer(onSend)
    const textarea = screen.getByTestId("composer")

    await user.type(textarea, "keep me{Enter}")

    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect((textarea as HTMLTextAreaElement).value).toBe("keep me")
  })

  it("shows the keyboard hint with a fine pointer", () => {
    renderComposer()

    expect(screen.getByText("Enter sends, Shift+Enter adds a line")).toBeInTheDocument()
  })

  it("hides the keyboard hint when the pointer is coarse", () => {
    const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query === "(pointer: coarse)",
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as unknown as MediaQueryList,
    )

    try {
      renderComposer()

      expect(screen.queryByText("Enter sends, Shift+Enter adds a line")).not.toBeInTheDocument()
    } finally {
      matchMedia.mockRestore()
    }
  })

  it("shows stop while a run is active", () => {
    const onStop = vi.fn()
    render(
      <I18nProvider initialLocale="en">
        <Composer onSend={vi.fn()} onStop={onStop} running />
      </I18nProvider>,
    )

    expect(screen.getByTestId("stop")).toBeInTheDocument()
  })
})
