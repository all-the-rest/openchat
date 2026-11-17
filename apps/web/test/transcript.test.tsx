import type { Message, MessageStatus } from "@openchat/contracts"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { Transcript } from "../src/chat/Transcript"
import { I18nProvider } from "../src/i18n/provider"
import { ThemeProvider } from "../src/theme/provider"

function message(id: string, status: MessageStatus = "complete", text = `message ${id}`): Message {
  return {
    id,
    sessionID: "ses_1",
    role: "assistant",
    parts: [{ type: "text", id: `part_${id}`, text }],
    created: 1,
    status,
  }
}

function renderTranscript(
  messages: Message[],
  actions: { onContinue?: () => void; onRetryLast?: () => void } = {},
) {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale="en">
        <Transcript
          messages={messages}
          loading={false}
          failed={false}
          onRetry={() => undefined}
          onContinue={actions.onContinue}
          onRetryLast={actions.onRetryLast}
        />
      </I18nProvider>
    </ThemeProvider>,
  )
}

/**
 * jsdom has no layout, so scrollHeight/clientHeight/scrollTop are stubbed on the
 * scroll container. `top` exposes the value the component wrote.
 */
function stubScroll(element: HTMLElement, metrics: { scrollHeight: number; clientHeight: number }) {
  let top = 0
  Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => metrics.scrollHeight })
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => metrics.clientHeight })
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value
    },
  })
  return {
    get top() {
      return top
    },
    set top(value: number) {
      top = value
    },
  }
}

describe("Transcript scrolling", () => {
  it("keeps the bottom pinned while streaming and scrolls on a new message", () => {
    const first = message("m1")
    const { rerender } = renderTranscript([first])
    const container = screen.getByTestId("transcript")
    const scroll = stubScroll(container, { scrollHeight: 1_000, clientHeight: 400 })

    rerender(
      <ThemeProvider initialTheme="dark">
        <I18nProvider initialLocale="en">
          <Transcript
            messages={[first, message("m2")]}
            loading={false}
            failed={false}
            onRetry={() => undefined}
          />
        </I18nProvider>
      </ThemeProvider>,
    )

    expect(scroll.top).toBe(1_000)
    expect(screen.queryByTestId("jump-latest")).not.toBeInTheDocument()
  })

  it("offers jump-to-latest after scrolling up and pins again on click", () => {
    renderTranscript([message("m1"), message("m2")])
    const container = screen.getByTestId("transcript")
    const scroll = stubScroll(container, { scrollHeight: 1_000, clientHeight: 400 })

    scroll.top = 100
    fireEvent.scroll(container)

    const jump = screen.getByTestId("jump-latest")
    expect(jump).toHaveAccessibleName("Jump to latest message")

    fireEvent.click(jump)

    expect(scroll.top).toBe(1_000)
    expect(screen.queryByTestId("jump-latest")).not.toBeInTheDocument()
  })

  it("announces completion once a streaming message finishes", () => {
    const streaming = message("m1", "streaming")
    const { rerender } = renderTranscript([streaming])
    expect(screen.queryByText("Answer complete")).not.toBeInTheDocument()

    rerender(
      <ThemeProvider initialTheme="dark">
        <I18nProvider initialLocale="en">
          <Transcript
            messages={[message("m1")]}
            loading={false}
            failed={false}
            onRetry={() => undefined}
          />
        </I18nProvider>
      </ThemeProvider>,
    )

    expect(screen.getByText("Answer complete")).toBeInTheDocument()
  })

  it("copies the message text", async () => {
    const writeText = vi.mocked(navigator.clipboard.writeText)
    writeText.mockClear()
    renderTranscript([message("m1", "complete", "copy me")])

    fireEvent.click(screen.getByRole("button", { name: "Copy message" }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("copy me"))
  })

  it("offers Continue and Retry under a stopped assistant message", async () => {
    const user = userEvent.setup()
    const onContinue = vi.fn()
    const onRetryLast = vi.fn()
    renderTranscript([message("m1", "stopped", "half an answer")], { onContinue, onRetryLast })

    const continueButton = screen.getByRole("button", { name: "Continue" })
    const retryButton = screen.getByRole("button", { name: "Retry" })
    expect(continueButton).toBeInTheDocument()
    expect(retryButton).toBeInTheDocument()

    await user.click(continueButton)
    await user.click(retryButton)

    expect(onContinue).toHaveBeenCalledTimes(1)
    expect(onRetryLast).toHaveBeenCalledTimes(1)
  })

  it("hides Continue and Retry while the last assistant message streams", () => {
    renderTranscript([message("m1", "streaming", "still going")], {
      onContinue: vi.fn(),
      onRetryLast: vi.fn(),
    })

    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument()
  })

  it("reaches the recovery actions with the keyboard", async () => {
    const user = userEvent.setup()
    const onContinue = vi.fn()
    renderTranscript([message("m1", "complete", "done")], { onContinue })

    const continueButton = screen.getByRole("button", { name: "Continue" })
    continueButton.focus()
    expect(continueButton).toHaveFocus()

    await user.keyboard("{Enter}")

    expect(onContinue).toHaveBeenCalledTimes(1)
  })
})
