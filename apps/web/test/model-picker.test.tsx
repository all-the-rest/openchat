import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CompletionProvider, COMPLETION_STORAGE_KEY } from "../src/chat/completion"
import { FAVORITES_STORAGE_KEY } from "../src/chat/favorites"
import { ModelSelect } from "../src/chat/ModelPicker"
import { I18nProvider } from "../src/i18n/provider"
import { CATALOGUE } from "./model-fixtures"

function wrap(children: ReactNode) {
  return render(
    <I18nProvider initialLocale="en">
      <CompletionProvider catalogue={CATALOGUE}>{children}</CompletionProvider>
    </I18nProvider>,
  )
}

beforeEach(() => window.localStorage.clear())
afterEach(() => window.localStorage.clear())

describe("model combobox", () => {
  it("groups options by provider and exposes capability badges", async () => {
    const user = userEvent.setup()
    wrap(<ModelSelect />)
    await user.click(screen.getByTestId("model-select"))

    const menu = screen.getByTestId("model-menu")
    expect(within(menu).getByText("OpenAI")).toBeInTheDocument()
    expect(within(menu).getByText("Fake Provider")).toBeInTheDocument()
    expect(within(menu).getByText("Local Models")).toBeInTheDocument()
    expect(within(menu).getByRole("menuitem", { name: /GPT X: Default/ })).toBeInTheDocument()
    expect(within(menu).getAllByRole("img", { name: "Tools" }).length).toBeGreaterThan(0)
    expect(within(menu).getAllByRole("img", { name: "Reasoning" }).length).toBeGreaterThan(0)
    expect(within(menu).getAllByRole("img", { name: "Image input" }).length).toBeGreaterThan(0)
    expect(within(menu).getByText("Deprecated")).toBeInTheDocument()
  })

  it("filters by model name and by provider name", async () => {
    const user = userEvent.setup()
    wrap(<ModelSelect />)
    await user.click(screen.getByTestId("model-select"))
    const search = screen.getByTestId("model-search")

    await user.type(search, "phi")
    expect(screen.queryByRole("menuitem", { name: /GPT X/ })).not.toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: /Phi Local/ })).toBeInTheDocument()

    await user.clear(search)
    await user.type(search, "fake provider")
    expect(screen.queryByRole("menuitem", { name: /GPT X/ })).not.toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: /Fake Echo/ })).toBeInTheDocument()
  })

  it("offers variants as a second level and applies the chosen one", async () => {
    const user = userEvent.setup()
    wrap(<ModelSelect />)
    await user.click(screen.getByTestId("model-select"))

    expect(screen.getByRole("menuitem", { name: /GPT X: fast/ })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: /GPT X: slow/ })).toBeInTheDocument()
    await user.click(screen.getByRole("menuitem", { name: /GPT X: slow/ }))

    expect(JSON.parse(window.localStorage.getItem(COMPLETION_STORAGE_KEY) ?? "{}")).toMatchObject({
      model: "gpt-x", variant: "slow",
    })
    expect(screen.getByTestId("model-select")).toHaveTextContent("GPT X: slow")
    expect(screen.queryByTestId("model-menu")).not.toBeInTheDocument()
  })

  it("is keyboard reachable with arrows and closes on Escape", async () => {
    const user = userEvent.setup()
    wrap(<ModelSelect />)
    await user.click(screen.getByTestId("model-select"))
    screen.getByTestId("model-search").focus()

    await user.keyboard("{ArrowDown}")
    expect(document.activeElement).toHaveAttribute("data-testid", "model-option")
    await user.keyboard("{ArrowDown}")
    expect(document.activeElement).toHaveTextContent(/GPT X: fast/)
    await user.keyboard("{Enter}")
    expect(JSON.parse(window.localStorage.getItem(COMPLETION_STORAGE_KEY) ?? "{}")).toMatchObject({
      model: "gpt-x", variant: "fast",
    })

    await user.click(screen.getByTestId("model-select"))
    await user.keyboard("{Escape}")
    expect(screen.queryByTestId("model-menu")).not.toBeInTheDocument()
    expect(document.activeElement).toHaveAttribute("data-testid", "model-select")
  })

  it("pins a starred model to the top and removes it with one click", async () => {
    const user = userEvent.setup()
    wrap(<ModelSelect />)
    await user.click(screen.getByTestId("model-select"))

    await user.click(
      screen.getByRole("button", { name: "Add Fake Echo to favorites" }),
    )
    const menu = screen.getByTestId("model-menu")
    expect(within(menu).getAllByTestId("model-option")[0]).toHaveTextContent("Fake Echo")
    expect(JSON.parse(window.localStorage.getItem(FAVORITES_STORAGE_KEY) ?? "[]")).toEqual([
      { model: "fake/echo", variant: null },
    ])

    await user.click(
      screen.getByRole("button", { name: "Remove Fake Echo from favorites" }),
    )
    expect(JSON.parse(window.localStorage.getItem(FAVORITES_STORAGE_KEY) ?? "[]")).toEqual([])
    expect(within(menu).queryByText("Favorites")).not.toBeInTheDocument()
  })

  it("stars a model and one of its variants separately", async () => {
    const user = userEvent.setup()
    wrap(<ModelSelect />)
    await user.click(screen.getByTestId("model-select"))
    await user.click(
      screen.getByRole("button", { name: "Add GPT X: slow to favorites" }),
    )
    expect(JSON.parse(window.localStorage.getItem(FAVORITES_STORAGE_KEY) ?? "[]")).toEqual([
      { model: "gpt-x", variant: "slow" },
    ])
    expect(screen.getByRole("button", { name: "Add GPT X: Default to favorites" })).toBeInTheDocument()
  })

  it("shows a vanished favourite as stale and refuses to select it", async () => {
    window.localStorage.setItem(
      FAVORITES_STORAGE_KEY,
      JSON.stringify([{ model: "gone/model", variant: "fast" }]),
    )
    const user = userEvent.setup()
    wrap(<ModelSelect />)
    await user.click(screen.getByTestId("model-select"))

    const row = screen.getByRole("menuitem", { name: /gone\/model: fast/ })
    expect(row).toBeDisabled()
    expect(screen.getByText("Stale")).toBeInTheDocument()
    await user.click(row)
    expect(window.localStorage.getItem(COMPLETION_STORAGE_KEY)).toBeNull()
  })

  it("keeps a favourite pinned after a fresh mount", async () => {
    window.localStorage.setItem(
      FAVORITES_STORAGE_KEY,
      JSON.stringify([{ model: "local/phi", variant: null }]),
    )
    const user = userEvent.setup()
    wrap(<ModelSelect />)
    await user.click(screen.getByTestId("model-select"))

    expect(screen.getByText("Favorites")).toBeInTheDocument()
    expect(screen.getAllByTestId("model-option")[0]!).toHaveTextContent("Phi Local")
    await user.click(screen.getAllByTestId("model-option")[0]!)
    expect(JSON.parse(window.localStorage.getItem(COMPLETION_STORAGE_KEY) ?? "{}")).toMatchObject({
      model: "local/phi",
    })
  })
})
