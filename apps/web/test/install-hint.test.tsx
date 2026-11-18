import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { InstallHint } from "../src/components/InstallHint"
import { I18nProvider } from "../src/i18n/provider"

function matchMedia(standalone: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(display-mode: standalone)" ? standalone : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}

function installEvent() {
  const prompt = vi.fn().mockResolvedValue(undefined)
  const event = new Event("beforeinstallprompt", { cancelable: true })
  Object.defineProperty(event, "prompt", { value: prompt })
  Object.defineProperty(event, "userChoice", {
    value: Promise.resolve({ outcome: "accepted" as const }),
  })
  return { event, prompt }
}

function dispatch(event: Event): void {
  act(() => {
    window.dispatchEvent(event)
  })
}

function renderHint() {
  return render(
    <I18nProvider initialLocale="en">
      <InstallHint />
    </I18nProvider>,
  )
}

afterEach(() => vi.unstubAllGlobals())

describe("install hint", () => {
  it("renders nothing on an unsupported browser", () => {
    matchMedia(false)
    renderHint()
    expect(screen.queryByTestId("install-hint")).toBeNull()
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull()
  })

  it("appears only after a real beforeinstallprompt and uses the browser prompt", async () => {
    const user = userEvent.setup()
    matchMedia(false)
    renderHint()
    const { event, prompt } = installEvent()

    dispatch(event)
    expect(screen.getByTestId("install-hint")).toHaveTextContent(
      "Install OpenChat on this device for quick access.",
    )
    await user.click(screen.getByRole("button", { name: "Install" }))
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("install-hint")).toBeNull()
  })

  it("is hidden when already running standalone", () => {
    matchMedia(true)
    renderHint()
    dispatch(installEvent().event)
    expect(screen.queryByTestId("install-hint")).toBeNull()
  })

  it("stays dismissed across remounts", async () => {
    const user = userEvent.setup()
    matchMedia(false)
    const first = renderHint()
    dispatch(installEvent().event)
    await user.click(screen.getByTestId("install-dismiss"))
    expect(screen.queryByTestId("install-hint")).toBeNull()

    first.unmount()
    renderHint()
    dispatch(installEvent().event)
    expect(screen.queryByTestId("install-hint")).toBeNull()
  })
})
