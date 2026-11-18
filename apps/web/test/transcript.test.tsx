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
  highlightMessageID?: string,
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
          highlightMessageID={highlightMessageID}
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

describe("message deep link", () => {
  it("scrolls to the linked message and marks it", () => {
    const scrollIntoView = vi.fn()
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoView
    try {
      const { container } = renderTranscript([message("msg_1"), message("msg_2")], {}, "msg_2")

      const target = container.querySelector<HTMLElement>('[id="message-msg_2"]')
      expect(target).not.toBeNull()
      expect(target?.className).toContain("ring-2")
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
      // The link moves focus, so a keyboard user lands on what they followed
      // instead of on the document body.
      expect(document.activeElement).toBe(target)

      const other = container.querySelector<HTMLElement>('[id="message-msg_1"]')
      expect(other?.className).not.toContain("ring-2")
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })

  it("does not jump back while the session keeps streaming", () => {
    const scrollIntoView = vi.fn()
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoView
    try {
      const first = message("msg_1")
      const second = message("msg_2")
      const { rerender } = renderTranscript([first, second], {}, "msg_2")
      expect(scrollIntoView).toHaveBeenCalledTimes(1)

      // A new event arrives in the same session: the reader stays where they
      // were sent, instead of being centred on the link again.
      rerender(
        <ThemeProvider initialTheme="dark">
          <I18nProvider initialLocale="en">
            <Transcript
              messages={[first, second, message("msg_3")]}
              loading={false}
              failed={false}
              onRetry={() => undefined}
              highlightMessageID="msg_2"
            />
          </I18nProvider>
        </ThemeProvider>,
      )
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })

  it("scrolls when the target arrives after a loading render, and once per id", () => {
    const scrollIntoView = vi.fn()
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoView
    try {
      const first = message("msg_1")
      const second = message("msg_2")
      const { rerender } = renderTranscript([], {}, "msg_2")
      expect(scrollIntoView).not.toHaveBeenCalled()

      // The transcript was empty while the session loaded; the target shows up
      // with the first page of messages and must still be visited once.
      rerender(
        <ThemeProvider initialTheme="dark">
          <I18nProvider initialLocale="en">
            <Transcript
              messages={[first, second]}
              loading={false}
              failed={false}
              onRetry={() => undefined}
              highlightMessageID="msg_2"
            />
          </I18nProvider>
        </ThemeProvider>,
      )
      expect(scrollIntoView).toHaveBeenCalledTimes(1)

      // A second link in the same session is a new target and scrolls again.
      rerender(
        <ThemeProvider initialTheme="dark">
          <I18nProvider initialLocale="en">
            <Transcript
              messages={[first, second]}
              loading={false}
              failed={false}
              onRetry={() => undefined}
              highlightMessageID="msg_1"
            />
          </I18nProvider>
        </ThemeProvider>,
      )
      expect(scrollIntoView).toHaveBeenCalledTimes(2)
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })

  it("ignores a message id that is not in the transcript", () => {
    const scrollIntoView = vi.fn()
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoView
    try {
      const { container } = renderTranscript([message("msg_1")], {}, "missing")
      expect(scrollIntoView).not.toHaveBeenCalled()
      expect(container.querySelector("[data-highlighted]")).toBeNull()
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })
})

describe("Transcript empty state", () => {
  it("centres the same hero the landing page shows", () => {
    renderTranscript([])

    expect(
      screen.getByRole("heading", { level: 2, name: "What do you want to work on?" }),
    ).toBeInTheDocument()
    expect(screen.getByText("Send a message to start a new chat.")).toBeInTheDocument()
    expect(screen.getByTestId("transcript-body")).toHaveClass("min-h-full", "justify-center")
  })

  it("keeps the transcript top-aligned once messages exist", () => {
    renderTranscript([message("m1")])

    expect(screen.getByTestId("transcript-body")).not.toHaveClass("justify-center")
  })
})

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
    // A solid surface with a strong edge and a layer shadow: the disc floats
    // over the transcript, so it must not read as part of the content.
    expect(jump).toHaveClass("bg-elevated", "border-strong", "shadow-lg")

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
