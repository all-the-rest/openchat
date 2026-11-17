import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { I18nProvider } from "../src/i18n/provider"
import { Markdown } from "../src/render/Markdown"
import { ThemeProvider } from "../src/theme/provider"

function renderMarkdown(text: string) {
  const view = render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale="en">
        <Markdown text={text} />
      </I18nProvider>
    </ThemeProvider>,
  )
  return view
}

const MALFORMED: Array<[string, string]> = [
  ["an unterminated fenced code block", "```ts\nconst answer = 42"],
  ["unclosed inline math", "Inline $x + 1 stays text"],
  ["invalid block math", "$$\n\\frac{1}{2\n$$"],
  ["a table with mismatched columns", "| a | b |\n| --- |\n| 1 | 2 | 3 |"],
  ["an unclosed emphasis and link", "**bold [link](https://example.com"],
  ["deeply nested brackets", `${"[".repeat(200)}x${"]".repeat(200)}`],
  ["a raw script tag", "<script>globalThis.__openchatPwned = true</script>"],
  ["a raw iframe tag", '<iframe src="https://example.com"></iframe>'],
]

describe("malformed model output", () => {
  it.each(MALFORMED)("survives %s", (_label, text) => {
    const { container } = renderMarkdown(text)

    expect(container.textContent?.length ?? 0).toBeGreaterThan(0)
    expect(container.querySelector("script")).toBeNull()
    expect(container.querySelector("iframe")).toBeNull()
    expect((globalThis as { __openchatPwned?: boolean }).__openchatPwned).toBeUndefined()
  })
})

describe("oversized blocks", () => {
  it("renders a very long single line without dropping it", () => {
    const line = "a".repeat(50_000)
    const { container } = renderMarkdown(line)

    expect(container.textContent).toContain(line)
  })

  it("renders a very long fenced block with its language label", () => {
    const code = `const value = "${"x".repeat(100_000)}"`
    renderMarkdown(`\`\`\`ts\n${code}\n\`\`\``)

    expect(screen.getByText("ts")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument()
  })

  it("renders an oversized paragraph with many blocks without throwing", () => {
    const text = Array.from({ length: 500 }, (_unused, index) => `paragraph ${index} $${index}$`).join(
      "\n\n",
    )
    const { container } = renderMarkdown(text)

    expect(container.textContent).toContain("paragraph 499")
  })
})
