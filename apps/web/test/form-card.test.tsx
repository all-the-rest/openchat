import type { FormRequest } from "@openchat/contracts"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventStreamProvider } from "../src/api/events"
import { ApiError } from "../src/api/transport"
import { FormCard } from "../src/chat/FormCard"
import type { FormsValue } from "../src/chat/forms"
import { SessionsProvider } from "../src/chat/sessions"
import { I18nProvider } from "../src/i18n/provider"
import { ChatPage } from "../src/pages/ChatPage"
import { ThemeProvider } from "../src/theme/provider"

const mocks = vi.hoisted(() => ({
  listMessages: vi.fn(),
  listInbox: vi.fn(),
  cancelQueued: vi.fn(),
  listSessions: vi.fn(),
  chatFiles: vi.fn(),
  deleteChatFile: vi.fn(),
  chatFileDownloadUrl: vi.fn(),
  createSession: vi.fn(),
  renameSession: vi.fn(),
  deleteSession: vi.fn(),
  prompt: vi.fn(),
  interrupt: vi.fn(),
  listPermissions: vi.fn(async () => []),
  replyPermission: vi.fn(async () => undefined),
  listForms: vi.fn(async (): Promise<FormRequest[]> => []),
  replyForm: vi.fn(async () => undefined),
  models: vi.fn(async () => []),
  agents: vi.fn(async () => []),
  info: vi.fn(async () => ({
    dictation: { enabled: false, maxSeconds: 60, maxBytes: 1024 },
  })),
}))

// Partial mock: the real module also exports `ApiError`, which the form hook
// narrows with `instanceof`. Stubbing only `api` keeps that class identity.
vi.mock("../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/client")>()
  return { ...actual, api: mocks }
})

const form: FormRequest = {
  id: "frm_1",
  sessionID: "ses_1",
  title: "Before I continue",
  fields: [
    {
      key: "summary",
      type: "string",
      title: "What should the answer cover?",
      required: true,
      placeholder: "For example: the costs",
    },
    {
      key: "tone",
      type: "string",
      title: "Tone",
      options: [
        { value: "brief", label: "Brief" },
        { value: "detailed", label: "Detailed" },
      ],
    },
    { key: "confirm", type: "boolean", title: "Share with the team" },
    { key: "count", type: "integer", title: "How many rows?", minimum: 1 },
    {
      key: "channels",
      type: "multiselect",
      title: "Channels",
      options: [
        { value: "email", label: "Email" },
        { value: "chat", label: "Chat" },
      ],
    },
    { key: "external", type: "external", title: "Approve in the console", url: "https://example.test" },
  ],
}

function value(overrides: Partial<FormsValue> = {}): FormsValue {
  return {
    forms: [form],
    busy: false,
    failure: false,
    submitted: new Set<string>(),
    expired: new Set<string>(),
    reply: vi.fn(async () => true),
    ...overrides,
  }
}

function withI18n(children: ReactNode) {
  return <I18nProvider initialLocale="en">{children}</I18nProvider>
}

describe("form external step links", () => {
  function externalForm(url: string): FormRequest {
    return {
      ...form,
      fields: [{ key: "external", type: "external", title: "Approve in the console", url }],
    }
  }

  it("links an absolute https URL in a new tab", () => {
    render(withI18n(<FormCard form={externalForm("https://console.example.test/approve")} value={value()} />))

    const link = screen.getByTestId("form-external-external")
    expect(link).toHaveAttribute("href", "https://console.example.test/approve")
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", "noreferrer noopener")
  })

  it("links an absolute http URL too", () => {
    render(withI18n(<FormCard form={externalForm("http://localhost:4096/approve")} value={value()} />))

    expect(screen.getByTestId("form-external-external")).toHaveAttribute(
      "href",
      "http://localhost:4096/approve",
    )
  })

  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["a relative path", "/approve"],
    ["garbage", "not a url"],
    ["an empty string", ""],
  ])("keeps %s as plain hint text without an anchor", (_label, url) => {
    render(withI18n(<FormCard form={externalForm(url)} value={value()} />))

    expect(screen.queryByTestId("form-external-external")).toBeNull()
    expect(
      screen.queryByRole("link", { name: "Open the external step" }),
    ).toBeNull()
    expect(screen.getByText("The agent completes this step on another page.")).toBeInTheDocument()
  })
})

describe("form card", () => {
  it("renders every field type the schema exposes", () => {
    render(withI18n(<FormCard form={form} value={value()} />))

    expect(screen.getByText("Before I continue")).toBeInTheDocument()
    expect(screen.getByLabelText(/What should the answer cover/)).toBeInTheDocument()
    expect(screen.getByLabelText("Tone")).toBeInTheDocument()
    expect(screen.getByLabelText("Share with the team")).toBeInTheDocument()
    expect(screen.getByLabelText(/How many rows/)).toBeInTheDocument()
    expect(screen.getByRole("group", { name: "Channels" })).toBeInTheDocument()
    const external = screen.getByRole("link", { name: "Open the external step" })
    expect(external).toHaveAttribute("href", "https://example.test")
    expect(screen.getByTestId("form-submit")).toBeEnabled()
  })

  it("collects the answers and sends them to the host", async () => {
    const user = userEvent.setup()
    const reply = vi.fn(async () => true)
    render(withI18n(<FormCard form={form} value={value({ reply })} />))

    await user.type(screen.getByLabelText(/What should the answer cover/), "The largest costs")
    await user.selectOptions(screen.getByLabelText("Tone"), "detailed")
    await user.click(screen.getByLabelText("Share with the team"))
    await user.type(screen.getByLabelText(/How many rows/), "3")
    await user.click(screen.getByLabelText("Email"))
    await user.click(screen.getByTestId("form-submit"))

    await waitFor(() =>
      expect(reply).toHaveBeenCalledWith("frm_1", {
        summary: "The largest costs",
        tone: "detailed",
        confirm: true,
        count: 3,
        channels: ["email"],
      }),
    )
  })

  it("blocks a required field and says which value is missing", async () => {
    const user = userEvent.setup()
    const reply = vi.fn(async () => true)
    render(withI18n(<FormCard form={form} value={value({ reply })} />))

    await user.click(screen.getByTestId("form-submit"))
    expect(reply).not.toHaveBeenCalled()
    expect(screen.getAllByText("This value is required.").length).toBeGreaterThan(0)

    await user.type(screen.getByLabelText(/What should the answer cover/), "Costs")
    await user.click(screen.getByTestId("form-submit"))
    await waitFor(() => expect(reply).toHaveBeenCalledTimes(1))
  })

  it("shows a submitted state and disables the answer", () => {
    render(withI18n(<FormCard form={form} value={value({ submitted: new Set(["frm_1"]) })} />))
    expect(screen.getByTestId("form-submitted")).toHaveTextContent("Answer sent.")
    expect(screen.getByTestId("form-submit")).toBeDisabled()
  })

  it("shows an expired state for a form that closed first", () => {
    render(withI18n(<FormCard form={form} value={value({ expired: new Set(["frm_1"]) })} />))
    expect(screen.getByText("This form is no longer open.")).toBeInTheDocument()
    expect(screen.queryByTestId("form-submit")).toBeNull()
  })
})

type Listener = (event: MessageEvent) => void

class FakeEventSource {
  static instances: FakeEventSource[] = []
  private listeners = new Map<string, Set<Listener>>()

  constructor() {
    FakeEventSource.instances.push(this)
  }
  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(type, set)
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }
  close(): void {}
  emit(type: string, data: Record<string, unknown>): void {
    const envelope = { id: `evt_${type}`, created: 1, type, data }
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(envelope) } as MessageEvent)
    }
  }
}

function source(): FakeEventSource {
  const found = FakeEventSource.instances.at(-1)
  if (!found) throw new Error("EventSource was not created")
  return found
}

function renderChat() {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale="en">
        <SessionsProvider>
          <EventStreamProvider>
            <MemoryRouter initialEntries={["/c/ses_1"]}>
              <Routes>
                <Route path="/c/:sessionId" element={<ChatPage />} />
              </Routes>
            </MemoryRouter>
          </EventStreamProvider>
        </SessionsProvider>
      </I18nProvider>
    </ThemeProvider>,
  )
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal("EventSource", FakeEventSource)
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.listSessions.mockResolvedValue([
    { id: "ses_1", title: "Chat", directory: "/workspace", created: 1, updated: 1 },
  ])
  mocks.listMessages.mockResolvedValue([])
  mocks.listInbox.mockResolvedValue([])
  mocks.listPermissions.mockResolvedValue([])
  mocks.listForms.mockResolvedValue([])
  mocks.replyForm.mockResolvedValue(undefined)
  mocks.chatFiles.mockResolvedValue({
    files: [],
    quota: { usedBytes: 0, quotaBytes: 1024, totalUsedBytes: 0, totalQuotaBytes: 4096 },
  })
  mocks.info.mockResolvedValue({
    dictation: { enabled: false, maxSeconds: 60, maxBytes: 1024 },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("form events", () => {
  it("adds a card on form.created and removes it on form.replied", async () => {
    renderChat()
    await waitFor(() => expect(source()).toBeDefined())
    expect(screen.queryByTestId("form-card")).toBeNull()

    act(() =>
      source().emit("form.created", {
        sessionID: "ses_1",
        form: {
          id: "frm_live",
          sessionID: "ses_1",
          title: "Live form",
          fields: [{ key: "note", type: "string", title: "Note" }],
        },
      }),
    )
    const card = await screen.findByTestId("form-card")
    expect(card).toHaveAttribute("data-form-id", "frm_live")

    act(() =>
      source().emit("form.replied", {
        sessionID: "ses_1",
        id: "frm_live",
        answer: { note: "done" },
      }),
    )
    await waitFor(() => expect(screen.queryByTestId("form-card")).not.toBeInTheDocument())
  })

  it("replies through the API and keeps the list in step", async () => {
    mocks.listForms.mockResolvedValue([form])
    const user = userEvent.setup()
    renderChat()

    await screen.findByTestId("form-card")
    await user.type(screen.getByLabelText(/What should the answer cover/), "Costs")
    await user.click(screen.getByTestId("form-submit"))

    await waitFor(() =>
      expect(mocks.replyForm).toHaveBeenCalledWith("ses_1", "frm_1", { summary: "Costs" }),
    )
    expect(await screen.findByTestId("form-submitted")).toBeInTheDocument()

    act(() =>
      source().emit("form.replied", { sessionID: "ses_1", id: "frm_1", answer: {} }),
    )
    await waitFor(() => expect(screen.queryByTestId("form-card")).not.toBeInTheDocument())
  })

  it("keeps the card and shows the failure alert when the host is unavailable", async () => {
    mocks.listForms.mockResolvedValue([form])
    mocks.replyForm.mockRejectedValueOnce(
      new ApiError(502, "The host did not answer", "unavailable"),
    )
    const user = userEvent.setup()
    renderChat()

    await screen.findByTestId("form-card")
    await user.type(screen.getByLabelText(/What should the answer cover/), "Costs")
    await user.click(screen.getByTestId("form-submit"))

    // Only not_found/conflict expire a card; any other ApiError is retryable,
    // so the form stays open with a localized alert instead of a dead card.
    expect(
      await screen.findByText("The answer could not be sent. Try again."),
    ).toHaveAttribute("role", "alert")
    expect(mocks.replyForm).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("form-card")).toHaveAttribute("data-form-id", "frm_1")
    expect(screen.queryByTestId("form-submitted")).toBeNull()
    expect(screen.getByTestId("form-submit")).toBeEnabled()
  })
})
