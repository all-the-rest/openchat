import type { ToolPart } from "@openchat/contracts"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { I18nProvider } from "../src/i18n/provider"
import { ToolCard } from "../src/render/ToolCard"

const basePart: ToolPart = {
  type: "tool",
  id: "tool_1",
  callID: "call_1",
  name: "read_file",
  status: "success",
  input: "src/index.ts",
  output: "export const value = 1",
  startedAt: 1000,
  endedAt: 1420,
}

function renderTool(part: ToolPart) {
  return render(
    <I18nProvider initialLocale="en">
      <ToolCard part={part} />
    </I18nProvider>,
  )
}

describe("ToolCard", () => {
  it("shows name, status and duration and keeps input/output collapsed", () => {
    renderTool(basePart)

    expect(screen.getByText("read_file")).toBeInTheDocument()
    expect(screen.getByText("Done")).toBeInTheDocument()
    expect(screen.getByText("420 ms")).toBeInTheDocument()

    expect(screen.getByRole("button", { name: "Input" })).toHaveAttribute(
      "aria-expanded",
      "false",
    )
    expect(screen.getByText("src/index.ts")).not.toBeVisible()

    fireEvent.click(screen.getByRole("button", { name: "Input" }))
    expect(screen.getByRole("button", { name: "Input" })).toHaveAttribute(
      "aria-expanded",
      "true",
    )
    expect(screen.getByText("src/index.ts")).toBeVisible()

    fireEvent.click(screen.getByRole("button", { name: "Output" }))
    expect(screen.getByText("export const value = 1")).toBeVisible()
  })

  it("truncates long output and expands it on request", async () => {
    const user = userEvent.setup()
    const long = "x".repeat(2500)
    renderTool({ ...basePart, output: long })

    await user.click(screen.getByRole("button", { name: "Output" }))

    const pre = screen.getByText(/^x+…$/u)
    expect(pre.textContent).toHaveLength(2001)

    await user.click(screen.getByRole("button", { name: "Show full" }))
    expect(screen.getByText(long)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Show less" })).toBeInTheDocument()
  })

  it("shows the error state without breaking the card", () => {
    renderTool({
      ...basePart,
      status: "error",
      output: undefined,
      error: "ENOENT: no such file",
    })

    expect(screen.getByText("ENOENT: no such file")).toBeInTheDocument()
    expect(screen.getAllByText("Error").length).toBeGreaterThanOrEqual(2)
  })
})
