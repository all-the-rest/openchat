import { render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { I18nProvider } from "../src/i18n/provider"
import { Markdown } from "../src/render/Markdown"
import { ThemeProvider } from "../src/theme/provider"

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => {
      throw new Error("broken diagram")
    }),
  },
}))

function renderMarkdown(text: string) {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale="en">
        <Markdown text={text} />
      </I18nProvider>
    </ThemeProvider>,
  )
}

const RICH = [
  "# Rendering test",
  "",
  "- first item",
  "- second item",
  "",
  "| Name | Value |",
  "| --- | --- |",
  "| alpha | 1 |",
  "",
  "Inline math $E = mc^2$ stays inline.",
  "",
  "```ts",
  "const answer: number = 42",
  "```",
].join("\n")

describe("Markdown renderer", () => {
  it("renders headings, lists and tables as semantic elements", () => {
    renderMarkdown(RICH)

    expect(screen.getByRole("heading", { level: 1, name: "Rendering test" })).toBeInTheDocument()
    expect(screen.getAllByRole("listitem")).toHaveLength(2)
    expect(screen.getByRole("table")).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument()
    expect(screen.getByRole("cell", { name: "alpha" })).toBeInTheDocument()
  })

  it("renders math with KaTeX", () => {
    const { container } = renderMarkdown("Inline math $E = mc^2$ stays inline.")

    expect(container.querySelector(".katex")).not.toBeNull()
  })

  it("renders fenced code with a language label and copy action", () => {
    const { container } = renderMarkdown(RICH)

    expect(screen.getByText("ts", { exact: true })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument()
    expect(container.querySelector("pre code")?.textContent).toContain(
      "const answer: number = 42",
    )
  })

  it("does not execute or inject raw HTML from the model output", () => {
    const { container } = renderMarkdown(
      'Hello <script>window.__pwned = true</script>\n\n<img src="x" onerror="window.__pwned = true" />\n\n<b>bold</b>',
    )

    expect(container.querySelector("script")).toBeNull()
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("b")).toBeNull()
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined()
  })

  it("only embeds data: image URLs and never fetches remote images", () => {
    const { container } = renderMarkdown(
      "![diagram](https://example.invalid/cat.png)\n\n![pixel](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==)",
    )

    const images = container.querySelectorAll("img")
    expect(images).toHaveLength(1)
    expect(images[0]?.getAttribute("src")).toMatch(/^data:image\/png/)
    const link = screen.getByRole("link", { name: "diagram" })
    expect(link.getAttribute("href")).toBe("https://example.invalid/cat.png")
  })

  it("falls back to the source when mermaid refuses to render", async () => {
    renderMarkdown(["```mermaid", "graph TD", "  A-->B", "```"].join("\n"))

    const fallback = await screen.findByTestId("mermaid-fallback")
    expect(fallback.textContent ?? "").toContain("graph TD")
    expect(within(fallback).getByText("mermaid", { exact: true })).toBeInTheDocument()
  })
})
