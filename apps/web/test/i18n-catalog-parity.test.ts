import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { compareCatalogs, parityProblems } from "../scripts/catalog-parity.ts"
import { inspectCatalogs, staleProblems } from "../scripts/catalogs.ts"

function po(entries: Record<string, string>): string {
  const lines = [
    'msgid ""',
    'msgstr ""',
    '"Content-Type: text/plain; charset=utf-8\\n"',
    "",
  ]
  for (const [id, text] of Object.entries(entries)) {
    lines.push("#. js-lingui-explicit-id", `msgid "${id}"`, `msgstr "${text}"`, "")
  }
  return lines.join("\n")
}

function fixture(files: Record<string, Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "openchat-catalog-"))
  for (const [locale, entries] of Object.entries(files)) {
    const dir = join(root, "src", "locales", locale)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "messages.po"), po(entries))
  }
  return root
}

describe("catalog parity gate", () => {
  it("fails when a source key is missing from German", () => {
    const parity = compareCatalogs(
      { entries: { "apps.title": "Apps", "apps.retry": "Retry" } },
      { entries: { "apps.title": "Apps" } },
    )
    expect(parity.missing).toEqual(["apps.retry"])
    expect(parity.extra).toEqual([])
    expect(parityProblems("de", parity)).toEqual([
      'de: missing message "apps.retry"',
    ])
  })

  it("fails when German has a key the source locale does not", () => {
    const parity = compareCatalogs(
      { entries: { "apps.title": "Apps" } },
      { entries: { "apps.title": "Apps", "apps.extra": "Zusatz" } },
    )
    expect(parity.extra).toEqual(["apps.extra"])
    expect(parityProblems("de", parity)).toEqual([
      'de: message "apps.extra" is not in the source locale',
    ])
  })

  it("fails when a shared key has an empty translation", () => {
    const parity = compareCatalogs(
      { entries: { "apps.title": "Apps" } },
      { entries: { "apps.title": "" } },
    )
    expect(parity.untranslated).toEqual(["apps.title"])
    expect(parityProblems("de", parity)).toEqual([
      'de: empty translation for "apps.title"',
    ])
  })

  it("accepts catalogs with the same ids and translations", () => {
    const entries = { "apps.title": "Apps", "apps.retry": "Retry" }
    const parity = compareCatalogs({ entries }, { entries })
    expect(parityProblems("de", parity)).toEqual([])
  })

  it("fails end to end when the German PO file misses a source key", async () => {
    const root = fixture({
      en: { "apps.title": "Apps", "apps.retry": "Retry" },
      de: { "apps.title": "Apps" },
    })
    try {
      const report = await inspectCatalogs(root)
      expect(report.problems).toEqual(['de: missing message "apps.retry"'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("fails when a committed bundle is missing or stale", async () => {
    const root = fixture({ en: { "apps.title": "Apps" }, de: { "apps.title": "Apps" } })
    try {
      const report = await inspectCatalogs(root)
      expect(staleProblems(report)).toHaveLength(2)

      for (const catalog of report.locales) {
        writeFileSync(catalog.compiledPath, catalog.compiled)
      }
      expect(staleProblems(report)).toEqual([])

      const english = report.locales.find((catalog) => catalog.locale === "en")
      if (!english) throw new Error("english catalog missing")
      writeFileSync(english.compiledPath, `${english.compiled} `)
      expect(staleProblems(report)).toEqual([
        `en: ${english.compiledPath} is stale; run \`pnpm --filter @openchat/web i18n:compile\``,
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
