import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { translate } from "../src/i18n"
import { de } from "../src/i18n/messages/de"
import { en } from "../src/i18n/messages/en"
import { I18nProvider, useI18n, useT } from "../src/i18n/provider"

function Probe() {
  const t = useT()
  const { locale, setLocale } = useI18n()
  return (
    <div>
      <h1>{t("landing.heading")}</h1>
      <p>{t("composer.hint")}</p>
      <button type="button" onClick={() => setLocale(locale === "en" ? "de" : "en")}>
        switch
      </button>
    </div>
  )
}

describe("i18n", () => {
  it("keeps the English and German key sets identical", () => {
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort())
  })

  it("never returns a raw key for any catalog entry", () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(translate("en", key)).not.toBe(key)
      expect(translate("de", key)).not.toBe(key)
    }
  })

  it("renders translated text in both locales and syncs <html lang>", async () => {
    const user = userEvent.setup()
    render(
      <I18nProvider initialLocale="en">
        <Probe />
      </I18nProvider>,
    )

    expect(screen.getByRole("heading")).toHaveTextContent("What do you want to work on?")
    expect(document.documentElement.lang).toBe("en")

    await user.click(screen.getByRole("button", { name: "switch" }))

    expect(screen.getByRole("heading")).toHaveTextContent("Woran möchtest du arbeiten?")
    expect(document.documentElement.lang).toBe("de")

    const body = document.body.textContent ?? ""
    for (const key of Object.keys(en)) {
      expect(body).not.toContain(key)
    }
  })

  it("interpolates named placeholders", () => {
    expect(translate("en", "render.errorCode", { code: "rate_limit" })).toBe("Code: rate_limit")
    expect(translate("de", "render.errorCode", { code: "rate_limit" })).toBe("Code: rate_limit")
  })
})
