import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventStreamProvider } from "../src/api/events"
import { CompletionPickers } from "../src/chat/CompletionPicker"
import {
  completeModelValue,
  COMPLETION_STORAGE_KEY,
  CompletionProvider,
  useCompletion,
} from "../src/chat/completion"
import { useChatSession } from "../src/chat/useChatSession"
import { I18nProvider } from "../src/i18n/provider"
import { CATALOGUE, MODELS } from "./model-fixtures"

const mocks = vi.hoisted(() => ({
  models: vi.fn(async () => []),
  agents: vi.fn(async () => []),
  listMessages: vi.fn(async () => []),
  listInbox: vi.fn(async () => []),
  prompt: vi.fn(async () => ({ ok: true, messageID: "msg_1" })),
}))

vi.mock("../src/api/client", () => ({ api: mocks }))

function wrap(children: ReactNode, initial?: {
  model: string | null; variant: string | null; agent: string | null
}) {
  return render(
    <I18nProvider initialLocale="en">
      <CompletionProvider catalogue={CATALOGUE} initial={initial}>
        {children}
      </CompletionProvider>
    </I18nProvider>,
  )
}

beforeEach(() => {
  window.localStorage.clear()
  mocks.prompt.mockClear()
})

afterEach(() => window.localStorage.clear())

describe("completion pickers", () => {
  it("persists the browser-wide choice and shows it beside the title", async () => {
    const user = userEvent.setup()
    wrap(<CompletionPickers />)

    expect(screen.getByTestId("model-select")).toBeInTheDocument()
    expect(screen.getByTestId("agent-select")).toBeInTheDocument()
    expect(screen.getByTestId("completion-active")).toHaveTextContent(
      "Model: Default · Agent: Default",
    )

    await user.click(screen.getByTestId("model-select"))
    await user.click(screen.getByRole("menuitem", { name: /GPT X: Default/ }))
    await user.selectOptions(screen.getByTestId("agent-select"), "build")

    expect(JSON.parse(window.localStorage.getItem(COMPLETION_STORAGE_KEY) ?? "{}")).toEqual({
      model: "gpt-x", variant: null, agent: "build",
    })
    expect(screen.getByTestId("completion-active")).toHaveTextContent(
      "Model: GPT X · Agent: Build",
    )
  })

  it("hides a picker whose catalogue is unavailable instead of showing it empty", () => {
    render(
      <I18nProvider initialLocale="en">
        <CompletionProvider catalogue={{ models: [], agents: CATALOGUE.agents }}>
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

  it("sends the persisted model, variant and agent with a prompt", async () => {
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
            catalogue={CATALOGUE}
            initial={{ model: "gpt-x", variant: "slow", agent: "build" }}
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
        variant: "slow",
        agent: "build",
      }),
    )
  })

  it("omits all three fields when the browser made no choice", async () => {
    function Probe() {
      const chat = useChatSession("ses_1")
      return <button onClick={() => void chat.send("hello")}>send</button>
    }
    const user = userEvent.setup()
    render(
      <I18nProvider initialLocale="en">
        <EventStreamProvider>
          <CompletionProvider catalogue={CATALOGUE}>
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
        variant: undefined,
        agent: undefined,
      }),
    )
  })

  it("drops the variant when switching to a different model", async () => {
    function Switch() {
      const { setModel } = useCompletion()
      return (
        <>
          <button onClick={() => setModel("gpt-x", "slow")}>first</button>
          <button onClick={() => setModel("fake/echo")}>second</button>
        </>
      )
    }
    const user = userEvent.setup()
    wrap(<Switch />)
    await user.click(screen.getByRole("button", { name: "first" }))
    expect(JSON.parse(window.localStorage.getItem(COMPLETION_STORAGE_KEY) ?? "{}")).toMatchObject({
      model: "gpt-x", variant: "slow",
    })
    await user.click(screen.getByRole("button", { name: "second" }))
    expect(JSON.parse(window.localStorage.getItem(COMPLETION_STORAGE_KEY) ?? "{}")).toEqual({
      model: "fake/echo", variant: null, agent: null,
    })
  })

  it("never sends a stale favourite model or its variant", async () => {
    expect(
      completeModelValue({ model: "gone/model", variant: "fast" }, MODELS),
    ).toEqual({ model: undefined, variant: undefined })

    function Probe() {
      const chat = useChatSession("ses_1")
      return <button onClick={() => void chat.send("hello")}>send</button>
    }
    const user = userEvent.setup()
    render(
      <I18nProvider initialLocale="en">
        <EventStreamProvider>
          <CompletionProvider
            catalogue={CATALOGUE}
            initial={{ model: "gone/model", variant: "fast", agent: "build" }}
          >
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
        variant: undefined,
        agent: "build",
      }),
    )
  })

  it("drops a variant that is no longer offered by the selected model", () => {
    expect(completeModelValue({ model: "gpt-x", variant: "gone" }, MODELS)).toEqual({
      model: "gpt-x", variant: undefined,
    })
  })

  it("forwards the stored model while the catalogue is empty", () => {
    expect(completeModelValue({ model: "gpt-x", variant: "slow" }, [])).toEqual({
      model: "gpt-x", variant: "slow",
    })
    expect(completeModelValue({ model: null, variant: null }, [])).toEqual({
      model: undefined, variant: undefined,
    })
  })
})
