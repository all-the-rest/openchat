import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CompletionProvider, COMPLETION_STORAGE_KEY } from "../src/chat/completion"
import { FAVORITES_STORAGE_KEY } from "../src/chat/favorites"
import { I18nProvider } from "../src/i18n/provider"
import { LOCALE_STORAGE_KEY } from "../src/i18n"
import { SettingsPage } from "../src/pages/SettingsPage"
import { ThemeProvider } from "../src/theme/provider"
import { CATALOGUE } from "./model-fixtures"

const mocks = vi.hoisted(() => ({
  info: vi.fn(async () => ({
    host: { reachable: true },
    server: { version: "2.2.0", mode: "fake", workspace: "/workspace" },
    models: [],
    agents: [],
    scenario: "default",
    dictation: { enabled: true, maxSeconds: 60, maxBytes: 1024 },
    code: { configured: false, expectedVersion: "2" },
    apps: { available: false },
    artifacts: { available: true },
  })),
  hostDefaultModel: vi.fn(async () => ({
    model: { id: "gpt-x", name: "GPT X", providerID: "openai" },
  })),
}))

vi.mock("../src/api/client", () => ({ api: mocks }))

function wrap(children: ReactNode) {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale="en">
        <CompletionProvider catalogue={CATALOGUE}>{children}</CompletionProvider>
      </I18nProvider>
    </ThemeProvider>,
  )
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  window.localStorage.clear()
})

describe("settings route", () => {
  it("renders the read-only server status", async () => {
    wrap(<SettingsPage />)
    const status = await screen.findByTestId("server-status")
    expect(status).toHaveTextContent("Server status")
    expect(screen.getByTestId("status-version")).toHaveTextContent("2.2.0")
    expect(screen.getByTestId("status-host")).toHaveTextContent("Host reachable")
    expect(screen.getByTestId("status-dictation")).toHaveTextContent("Available")
    expect(screen.getByTestId("status-documents")).toHaveTextContent("Available")
    expect(await screen.findByTestId("host-default-model")).toHaveTextContent("GPT X")
  })

  it("saves the language and the browser-wide model choice", async () => {
    const user = userEvent.setup()
    wrap(<SettingsPage />)
    await screen.findByTestId("server-status")

    await user.selectOptions(screen.getByTestId("locale-select"), "de")
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("de")
    expect(document.documentElement.lang).toBe("de")

    await user.click(screen.getByTestId("model-select"))
    await user.click(screen.getByRole("menuitem", { name: /GPT X: fast/ }))
    expect(JSON.parse(window.localStorage.getItem(COMPLETION_STORAGE_KEY) ?? "{}")).toEqual({
      model: "gpt-x",
      variant: "fast",
      agent: null,
    })
  })

  it("shows favourites first in the same default-model picker", async () => {
    window.localStorage.setItem(
      FAVORITES_STORAGE_KEY,
      JSON.stringify([{ model: "local/phi", variant: null }]),
    )
    const user = userEvent.setup()
    wrap(<SettingsPage />)
    await screen.findByTestId("server-status")

    await user.click(screen.getByTestId("model-select"))
    expect(screen.getByText("Favorites")).toBeInTheDocument()
    expect(screen.getAllByTestId("model-option")[0]!).toHaveTextContent("Phi Local")
    await user.click(screen.getAllByTestId("model-option")[0]!)
    expect(JSON.parse(window.localStorage.getItem(COMPLETION_STORAGE_KEY) ?? "{}")).toMatchObject({
      model: "local/phi",
    })
  })

  it("reports a failed status read without hiding the block", async () => {
    mocks.info.mockRejectedValueOnce(new Error("offline"))
    wrap(<SettingsPage />)
    expect(await screen.findByTestId("server-status")).toHaveTextContent(
      "Server status could not be loaded.",
    )
  })
})
