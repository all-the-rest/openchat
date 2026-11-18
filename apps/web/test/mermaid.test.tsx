import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { I18nProvider } from "../src/i18n/provider"
import { Mermaid } from "../src/render/Mermaid"
import { ThemeProvider } from "../src/theme/provider"

// A diagram renders at its own size; the mock keeps the SVG small so the test
// only has to observe where it is mounted, not how mermaid lays it out.
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({
      svg: '<svg viewBox="0 0 480 240" width="100%" style="max-width: 480px"><text>Start</text></svg>',
    })),
  },
}))

function renderMermaid() {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale="en">
        <Mermaid chart={"graph TD\n  A-->B"} />
      </I18nProvider>
    </ThemeProvider>,
  )
}

describe("Mermaid diagram", () => {
  it("keeps a readable minimum width inside a horizontal scroller", async () => {
    renderMermaid()

    const canvas = await screen.findByTestId("mermaid-canvas")
    const frame = screen.getByTestId("mermaid")

    expect(frame).toContainElement(canvas)
    expect(frame).toHaveClass("overflow-x-auto")
    expect(canvas).toHaveClass("min-w-[36rem]")
    // Without this the inline `max-width` mermaid writes wins over the canvas.
    expect(canvas).toHaveClass("[&>svg]:max-w-none")
    expect(canvas.querySelector("svg")).not.toBeNull()
  })
})
