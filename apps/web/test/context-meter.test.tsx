import type { TokenUsage } from "@openchat/contracts"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { CompletionProvider } from "../src/chat/completion"
import { ContextMeter } from "../src/chat/ContextMeter"
import { I18nProvider } from "../src/i18n/provider"

const usage: TokenUsage = {
  input: 1_000,
  output: 100,
  reasoning: 0,
  cache: { read: 0, write: 0 },
}

function renderMeter(value: TokenUsage | null, contextLimit?: number) {
  return render(
    <I18nProvider initialLocale="en">
      <CompletionProvider
        catalogue={{
          models: [
            {
              id: "test/model",
              name: "Test",
              providerID: "test",
              providerName: "Test Provider",
              variants: [],
              contextLimit: contextLimit ?? 0,
              capabilities: { tools: false, reasoning: false, image: false },
              status: "active",
              default: true,
            },
          ],
          agents: [],
        }}
      >
        <ContextMeter usage={value} />
      </CompletionProvider>
    </I18nProvider>,
  )
}

describe("ContextMeter", () => {
  it("shows used, limit and percent from the default model", () => {
    renderMeter(usage, 200_000)
    const meter = screen.getByTestId("context-fill")
    expect(meter).toHaveTextContent("1,000 / 200,000 (1%)")
    expect(meter).toHaveAttribute("title", expect.stringContaining("100% minus"))
  })

  it("stays neutral without usage", () => {
    renderMeter(null, 200_000)
    expect(screen.getByTestId("context-fill-unknown")).toBeInTheDocument()
    expect(screen.queryByTestId("context-fill")).toBeNull()
  })

  it("stays neutral when the host reports no window", () => {
    renderMeter(usage)
    expect(screen.getByTestId("context-fill-unknown")).toBeInTheDocument()
    expect(screen.queryByText(/\d+ \/ \d+/)).toBeNull()
  })
})
