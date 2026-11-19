import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { FallbackSettings } from "../src/components/FallbackSettings"
import { I18nProvider } from "../src/i18n/provider"

const mocks = vi.hoisted(() => ({
  fallback: vi.fn(),
}))

vi.mock("../src/api/client", () => ({ api: mocks }))

function wrap(children: ReactNode) {
  return render(<I18nProvider initialLocale="en">{children}</I18nProvider>)
}

describe("fallback settings", () => {
  it("shows a one-line hint when no chain is configured", async () => {
    mocks.fallback.mockResolvedValue({
      configured: false,
      invalid: false,
      chain: [],
      paidDailyCap: 0,
      paidTurnsToday: 0,
      turnsToday: 0,
    })
    wrap(<FallbackSettings />)

    const hint = await screen.findByTestId("fallback-unconfigured")
    expect(hint).toHaveTextContent("No fallback chain is configured.")
    expect(screen.queryByTestId("fallback-chain")).toBeNull()
  })

  it("lists the chain, the paid-turn cap and today's usage", async () => {
    mocks.fallback.mockResolvedValue({
      configured: true,
      invalid: false,
      chain: [
        { providerID: "free", modelID: "glm", isFree: true },
        { providerID: "paid", modelID: "gpt", variant: "fast", contextLimit: 128_000 },
      ],
      paidDailyCap: 3,
      paidTurnsToday: 2,
      turnsToday: 4,
    })
    wrap(<FallbackSettings />)

    const entries = await screen.findAllByTestId("fallback-entry")
    expect(entries).toHaveLength(2)
    expect(entries[0]).toHaveTextContent("free/glm")
    expect(entries[0]).toHaveTextContent("Free")
    expect(entries[1]).toHaveTextContent("paid/gpt")
    expect(entries[1]).toHaveTextContent("Variant: fast")
    expect(screen.getByTestId("fallback-cap")).toHaveTextContent("3 paid turns per day")
    expect(screen.getByTestId("fallback-paid-today")).toHaveTextContent("2")
    expect(screen.getByTestId("fallback-turns-today")).toHaveTextContent("4")
  })

  it("renders a cap of zero as off", async () => {
    mocks.fallback.mockResolvedValue({
      configured: true,
      invalid: false,
      chain: [{ providerID: "free", modelID: "glm", isFree: true }],
      paidDailyCap: 0,
      paidTurnsToday: 0,
      turnsToday: 1,
    })
    wrap(<FallbackSettings />)

    expect(await screen.findByTestId("fallback-cap")).toHaveTextContent("Off")
  })

  it("warns that a configured but invalid chain leaves fallback off", async () => {
    mocks.fallback.mockResolvedValue({
      configured: false,
      invalid: true,
      invalidReasonCode: "chain_json",
      chain: [],
      paidDailyCap: 0,
      paidTurnsToday: 0,
      turnsToday: 0,
    })
    wrap(<FallbackSettings />)

    const warning = await screen.findByTestId("fallback-invalid")
    expect(warning).toHaveTextContent(
      "The configured fallback chain is invalid; fallback is off.",
    )
    // Localized detail from the stable code, never the server's raw English.
    expect(warning).toHaveTextContent("The chain setting is not valid JSON.")
    expect(screen.getByTestId("fallback-invalid-code")).toHaveTextContent("chain_json")
    // It must not read like "nothing was configured": that hides the misconfig.
    expect(screen.queryByTestId("fallback-unconfigured")).toBeNull()
    expect(screen.queryByTestId("fallback-chain")).toBeNull()
  })

  it("warns when a turn outcome could not be written to the ledger", async () => {
    mocks.fallback.mockResolvedValue({
      configured: true,
      invalid: false,
      chain: [{ providerID: "free", modelID: "glm", isFree: true }],
      paidDailyCap: 0,
      paidTurnsToday: 0,
      turnsToday: 1,
      ledgerError: true,
    })
    wrap(<FallbackSettings />)

    const warning = await screen.findByTestId("fallback-ledger-error")
    expect(warning).toHaveTextContent(
      "Turn accounting could not be written; today's usage may be incomplete.",
    )
    // The settings still render; only accounting is degraded.
    expect(await screen.findByTestId("fallback-chain")).toBeInTheDocument()
  })

  it("offers a retry after a failed read", async () => {
    mocks.fallback
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        configured: false,
        invalid: false,
        chain: [],
        paidDailyCap: 0,
        paidTurnsToday: 0,
        turnsToday: 0,
      })
    const user = userEvent.setup()
    wrap(<FallbackSettings />)

    expect(await screen.findByTestId("fallback-error")).toHaveTextContent(
      "Fallback settings could not be loaded.",
    )
    await user.click(screen.getByTestId("fallback-retry"))
    expect(await screen.findByTestId("fallback-unconfigured")).toBeInTheDocument()
    expect(mocks.fallback).toHaveBeenCalledTimes(2)
  })
})
