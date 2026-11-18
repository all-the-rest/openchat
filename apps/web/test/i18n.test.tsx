import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { catalogs, translate, type MessageKey } from "../src/i18n"
import { I18nProvider, useI18n, useT } from "../src/i18n/provider"

function Probe() {
  const t = useT()
  const { locale, setLocale } = useI18n()
  return (
    <div>
      <h1>{t("landing.heading")}</h1>
      <p>{t("composer.hint")}</p>
      <p>{t("search.groupCount", { count: 3 })}</p>
      <button type="button" onClick={() => setLocale(locale === "en" ? "de" : "en")}>
        switch
      </button>
    </div>
  )
}

describe("i18n", () => {
  it("keeps the English and German key sets identical", () => {
    expect(Object.keys(catalogs.de).sort()).toEqual(Object.keys(catalogs.en).sort())
  })

  it("never returns a raw key for any catalog entry", () => {
    for (const key of Object.keys(catalogs.en) as MessageKey[]) {
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
    expect(screen.getByText("3 found")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "switch" }))

    expect(screen.getByRole("heading")).toHaveTextContent("Woran möchtest du arbeiten?")
    expect(document.documentElement.lang).toBe("de")
    expect(screen.getByText("3 gefunden")).toBeInTheDocument()

    const body = document.body.textContent ?? ""
    for (const key of Object.keys(catalogs.en)) {
      expect(body).not.toContain(key)
    }
  })

  it("interpolates named placeholders", () => {
    expect(translate("en", "render.errorCode", { code: "rate_limit" })).toBe("Code: rate_limit")
    expect(translate("de", "render.errorCode", { code: "rate_limit" })).toBe("Code: rate_limit")
    expect(translate("en", "search.groupCount", { count: 2 })).toBe("2 found")
    expect(translate("de", "search.groupCount", { count: 2 })).toBe("2 gefunden")
  })

  it("accepts the documented locale prop as the initial locale", () => {
    render(
      <I18nProvider locale="de">
        <Probe />
      </I18nProvider>,
    )
    expect(screen.getByRole("heading")).toHaveTextContent("Woran möchtest du arbeiten?")
    expect(document.documentElement.lang).toBe("de")
  })
})
