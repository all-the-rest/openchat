import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventStreamProvider } from "../src/api/events"
import { CompletionPickers } from "../src/chat/CompletionPicker"
import { COMPLETION_STORAGE_KEY, CompletionProvider } from "../src/chat/completion"
import { useChatSession } from "../src/chat/useChatSession"
import { I18nProvider } from "../src/i18n/provider"

const mocks = vi.hoisted(() => ({
  models: vi.fn(async () => []),
  agents: vi.fn(async () => []),
  listMessages: vi.fn(async () => []),
  listInbox: vi.fn(async () => []),
  prompt: vi.fn(async () => ({ ok: true, messageID: "msg_1" })),
}))

vi.mock("../src/api/client", () => ({ api: mocks }))

const catalogue = {
  models: [
    { id: "gpt-x", name: "GPT X", providerID: "openai" },
    { id: "fake/echo", name: "Fake Echo", providerID: "fake" },
  ],
  agents: [{ id: "build", name: "Build" }],
}

function wrap(children: ReactNode, initial?: { model: string | null; agent: string | null }) {
  return render(
    <I18nProvider initialLocale="en">
      <CompletionProvider catalogue={catalogue} initial={initial}>
        {children}
      </CompletionProvider>
    </I18nProvider>,
  )
}

beforeEach(() => {
  window.localStorage.clear()
  mocks.prompt.mockClear()
})

afterEach(() => {
  window.localStorage.clear()
})

describe("completion pickers", () => {
  it("renders both catalogues and persists the browser-wide choice", async () => {
    const user = userEvent.setup()
    wrap(<CompletionPickers />)

    expect(screen.getByTestId("model-select")).toBeInTheDocument()
    expect(screen.getByTestId("agent-select")).toBeInTheDocument()
    expect(screen.getByTestId("completion-active")).toHaveTextContent(
      "Model: Default · Agent: Default",
    )

    await user.selectOptions(screen.getByTestId("model-select"), "gpt-x")
    await user.selectOptions(screen.getByTestId("agent-select"), "build")

    expect(JSON.parse(window.localStorage.getItem(COMPLETION_STORAGE_KEY) ?? "{}")).toEqual({
      model: "gpt-x",
      agent: "build",
    })
    expect(screen.getByTestId("completion-active")).toHaveTextContent(
      "Model: GPT X · Agent: Build",
    )
  })

  it("hides a picker whose catalogue is unavailable instead of showing it empty", () => {
    render(
      <I18nProvider initialLocale="en">
        <CompletionProvider catalogue={{ models: [], agents: catalogue.agents }}>
          <CompletionPickers />
        </CompletionProvider>
      </I18nProvider>,
    )
    expect(screen.queryByTestId("model-select")).not.toBeInTheDocument()
    expect(screen.getByTestId("agent-select")).toBeInTheDocument()
  })

  it("hides everything while the catalogues are still loading", () => {
    mocks.models.mockReturnValue(new Promise(() => undefined))
    mocks.agents.mockReturnValue(new Promise(() => undefined))
    render(
      <I18nProvider initialLocale="en">
        <CompletionProvider>
          <CompletionPickers />
        </CompletionProvider>
      </I18nProvider>,
    )
    expect(screen.queryByTestId("model-select")).not.toBeInTheDocument()
    expect(screen.queryByTestId("agent-select")).not.toBeInTheDocument()
  })

  it("sends the persisted model and agent with a prompt", async () => {
    function Probe() {
      const chat = useChatSession("ses_1")
      return (
        <button type="button" data-testid="send-now" onClick={() => void chat.send("hello")}>
          send
        </button>
      )
    }
    const user = userEvent.setup()
    render(
      <I18nProvider initialLocale="en">
        <EventStreamProvider>
          <CompletionProvider
            catalogue={catalogue}
            initial={{ model: "gpt-x", agent: "build" }}
          >
            <Probe />
          </CompletionProvider>
        </EventStreamProvider>
      </I18nProvider>,
    )

    await user.click(screen.getByTestId("send-now"))
    await waitFor(() =>
      expect(mocks.prompt).toHaveBeenCalledWith("ses_1", {
        text: "hello",
        model: "gpt-x",
        agent: "build",
      }),
    )
  })

  it("omits both fields when the browser made no choice", async () => {
    function Probe() {
      const chat = useChatSession("ses_1")
      return <button onClick={() => void chat.send("hello")}>send</button>
    }
    const user = userEvent.setup()
    render(
      <I18nProvider initialLocale="en">
        <EventStreamProvider>
          <CompletionProvider catalogue={catalogue}>
            <Probe />
          </CompletionProvider>
        </EventStreamProvider>
      </I18nProvider>,
    )
    await user.click(screen.getByRole("button", { name: "send" }))
    await waitFor(() =>
      expect(mocks.prompt).toHaveBeenCalledWith("ses_1", {
        text: "hello",
        model: undefined,
        agent: undefined,
      }),
    )
  })
})
