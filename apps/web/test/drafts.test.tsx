import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Composer } from "../src/chat/Composer"
import { clearDraft, draftStorageKey, readDraft, writeDraft } from "../src/chat/drafts"
import { SurfaceProvider } from "../src/code/SurfaceProvider"
import { SurfaceSwitch } from "../src/code/SurfaceSwitch"
import { I18nProvider } from "../src/i18n/provider"
import { LandingPage } from "../src/pages/LandingPage"

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  create: vi.fn(),
}))

vi.mock("../src/api/client", () => ({ api: { info: mocks.info } }))
vi.mock("../src/api/events", () => ({
  useEventStream: () => ({ connection: "open", reconnect: 0 }),
}))
vi.mock("../src/chat/sessions", () => ({
  useSessions: () => ({
    sessions: [],
    loading: false,
    failed: false,
    refresh: vi.fn(),
    create: mocks.create,
  }),
}))

beforeEach(() => {
  mocks.info.mockResolvedValue({ code: { configured: true, expectedVersion: "2.3.0" } })
  mocks.create.mockResolvedValue({
    id: "ses_new",
    title: "",
    directory: "",
    created: 0,
    updated: 0,
  })
})

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  }
}

const textarea = () => screen.getByTestId("composer") as HTMLTextAreaElement

function renderComposer(props: Partial<ComponentProps<typeof Composer>> = {}) {
  const onSend = props.onSend ?? vi.fn(async () => undefined)
  const tree = (next: Partial<ComponentProps<typeof Composer>>) => (
    <I18nProvider initialLocale="en">
      <Composer
        onSend={next.onSend ?? onSend}
        onStop={vi.fn()}
        running={false}
        dictation={null}
        draftKey="ses_1"
        {...next}
      />
    </I18nProvider>
  )
  const view = render(tree(props))
  return { ...view, onSend, tree }
}

describe("draft store", () => {
  it("keeps drafts per session and clears them on request", () => {
    const storage = memoryStorage()

    expect(readDraft("ses_1", storage)).toBe("")
    writeDraft("ses_1", "alpha", storage)
    expect(readDraft("ses_1", storage)).toBe("alpha")
    expect(readDraft("ses_2", storage)).toBe("")

    writeDraft("ses_2", "beta", storage)
    clearDraft("ses_1", storage)
    expect(readDraft("ses_1", storage)).toBe("")
    expect(readDraft("ses_2", storage)).toBe("beta")
  })

  it("removes the entry instead of storing an empty draft", () => {
    const storage = memoryStorage()
    writeDraft("ses_1", "alpha", storage)
    expect(storage.getItem(draftStorageKey("ses_1"))).toBe("alpha")

    writeDraft("ses_1", "", storage)
    expect(storage.getItem(draftStorageKey("ses_1"))).toBeNull()
  })

  it("does nothing without a session or without storage", () => {
    const storage = memoryStorage()
    expect(() => writeDraft("", "alpha", storage)).not.toThrow()
    expect(() => clearDraft("", storage)).not.toThrow()
    expect(writeDraft("ses_1", "alpha", null)).toBeUndefined()
    expect(readDraft("ses_1", null)).toBe("")
  })
})

describe("Composer drafts", () => {
  it("survives a remount on the same session", async () => {
    const user = userEvent.setup()
    const first = renderComposer()
    await user.type(textarea(), "draft text")
    first.unmount()

    renderComposer()
    await waitFor(() => expect(textarea().value).toBe("draft text"))
    expect(readDraft("ses_1")).toBe("draft text")
  })

  it("keeps the draft when sending fails", async () => {
    const user = userEvent.setup()
    const onSend = vi.fn(async () => {
      throw new Error("offline")
    })
    renderComposer({ onSend })

    await user.type(textarea(), "keep me{Enter}")

    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect(textarea().value).toBe("keep me")
    expect(readDraft("ses_1")).toBe("keep me")
  })

  it("clears the draft when sending succeeds", async () => {
    const user = userEvent.setup()
    const { onSend } = renderComposer()

    await user.type(textarea(), "send me{Enter}")

    await waitFor(() => expect(onSend).toHaveBeenCalledWith("send me"))
    expect(textarea().value).toBe("")
    expect(readDraft("ses_1")).toBe("")
  })

  it("loads the draft of the session a reused composer now shows", async () => {
    const user = userEvent.setup()
    const view = renderComposer()
    await user.type(textarea(), "first")

    view.rerender(view.tree({ draftKey: "ses_2" }))
    await waitFor(() => expect(textarea().value).toBe(""))

    await user.type(textarea(), "second")
    view.rerender(view.tree({ draftKey: "ses_1" }))
    await waitFor(() => expect(textarea().value).toBe("first"))
    expect(readDraft("ses_2")).toBe("second")
  })
})

describe("Landing draft", () => {
  function renderLanding() {
    return render(
      <I18nProvider initialLocale="en">
        <MemoryRouter initialEntries={["/"]}>
          <SurfaceProvider>
            <SurfaceSwitch />
            <Routes>
              <Route path="/" element={<LandingPage />} />
              <Route path="/code" element={<p>code surface</p>} />
              <Route path="/code/*" element={<p>code surface</p>} />
            </Routes>
          </SurfaceProvider>
        </MemoryRouter>
      </I18nProvider>,
    )
  }

  it("keeps a prompt typed on / across a Code switch", async () => {
    const user = userEvent.setup()
    renderLanding()

    await user.type(await screen.findByTestId("composer"), "landing draft")
    await user.click(await screen.findByTestId("surface-code"))
    expect(await screen.findByText("code surface")).toBeInTheDocument()

    await user.click(screen.getByTestId("surface-chat"))
    await waitFor(() => expect(screen.getByTestId("composer")).toHaveValue("landing draft"))
    expect(readDraft("new")).toBe("landing draft")
  })
})
