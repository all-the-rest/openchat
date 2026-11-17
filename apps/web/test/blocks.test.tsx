import type { ErrorPart, ReasoningPart } from "@openchat/contracts"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { I18nProvider } from "../src/i18n/provider"
import { ErrorCard } from "../src/render/ErrorCard"
import { ReasoningBlock } from "../src/render/ReasoningBlock"

const errorPart: ErrorPart = {
  type: "error",
  id: "error_1",
  message: "The provider is overloaded.",
  code: "provider_error",
  retryable: true,
}

const reasoningPart: ReasoningPart = {
  type: "reasoning",
  id: "reason_1",
  text: "Checking the transcript before answering.",
}

describe("ErrorCard", () => {
  it("renders the message, the optional code and the retry hint", () => {
    render(
      <I18nProvider initialLocale="en">
        <ErrorCard part={errorPart} />
      </I18nProvider>,
    )

    expect(screen.getByRole("alert")).toHaveTextContent("The provider is overloaded.")
    expect(screen.getByText("Code: provider_error")).toBeInTheDocument()
    expect(screen.getByText("This error can be retried.")).toBeInTheDocument()
  })

  it("hides the code and retry hint when absent", () => {
    render(
      <I18nProvider initialLocale="en">
        <ErrorCard part={{ type: "error", id: "error_2", message: "Nope" }} />
      </I18nProvider>,
    )

    expect(screen.queryByText(/^Code:/)).not.toBeInTheDocument()
    expect(screen.queryByText("This error can be retried.")).not.toBeInTheDocument()
  })
})

describe("ReasoningBlock", () => {
  it("is expanded while streaming and collapses after completion", async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <I18nProvider initialLocale="en">
        <ReasoningBlock part={reasoningPart} streaming />
      </I18nProvider>,
    )

    expect(screen.getByText("Reasoning")).toBeInTheDocument()
    expect(screen.getByText(reasoningPart.text)).toBeVisible()

    rerender(
      <I18nProvider initialLocale="en">
        <ReasoningBlock part={reasoningPart} streaming={false} />
      </I18nProvider>,
    )

    await waitFor(() => {
      expect(screen.getByText(reasoningPart.text)).not.toBeVisible()
    })

    const toggle = screen.getByRole("button", { name: /Reasoning/ })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    await user.click(toggle)
    expect(screen.getByText(reasoningPart.text)).toBeVisible()
  })
})
