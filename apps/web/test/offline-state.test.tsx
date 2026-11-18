import { act, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Composer } from "../src/chat/Composer"
import { OfflineBanner } from "../src/components/OfflineBanner"
import { I18nProvider } from "../src/i18n/provider"

function setOnline(online: boolean): void {
  act(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: online })
    window.dispatchEvent(new Event(online ? "online" : "offline"))
  })
}

function renderShell() {
  render(
    <I18nProvider initialLocale="en">
      <OfflineBanner />
      <Composer onSend={vi.fn()} onStop={vi.fn()} running={false} />
    </I18nProvider>,
  )
}

afterEach(() => setOnline(true))

describe("offline state", () => {
  it("shows a polite banner only while the browser is offline", () => {
    renderShell()
    expect(screen.queryByTestId("offline-banner")).toBeNull()

    setOnline(false)
    const banner = screen.getByTestId("offline-banner")
    expect(banner).toHaveAttribute("role", "status")
    expect(banner).toHaveAttribute("aria-live", "polite")
    expect(banner).toHaveTextContent("You are offline")
    expect(banner).toHaveTextContent("Reconnect to continue")

    setOnline(true)
    expect(screen.queryByTestId("offline-banner")).toBeNull()
  })

  it("disables the composer and explains why while offline", () => {
    renderShell()
    setOnline(false)

    const textarea = screen.getByTestId("composer")
    expect(textarea).toBeDisabled()
    expect(screen.getByTestId("send")).toBeDisabled()
    expect(screen.getByText("Sending is unavailable while offline. Reconnect to start a new prompt."))
      .toBeInTheDocument()
    expect(screen.getByTestId("send")).toHaveAttribute(
      "aria-describedby",
      "offline-banner offline-composer-hint",
    )

    setOnline(true)
    expect(textarea).toBeEnabled()
    expect(screen.queryByText("Sending is unavailable while offline. Reconnect to start a new prompt."))
      .toBeNull()
  })
})
