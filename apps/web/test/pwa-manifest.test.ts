import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  BACKGROUND_COLOR,
  buildManifest,
  ICON_FILES,
  manifestJson,
  THEME_COLOR,
  type WebAppManifest,
} from "../../../scripts/pwa-manifest.ts"

const WEB_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const committed = readFileSync(join(WEB_DIR, "public", "manifest.webmanifest"), "utf8")
const html = readFileSync(join(WEB_DIR, "index.html"), "utf8")

describe("web app manifest", () => {
  it("has installable fields, spec 08 colors and an explicit language", () => {
    const manifest: WebAppManifest = buildManifest()
    expect(manifest.name).toBe("OpenChat")
    expect(manifest.short_name).toBe("OpenChat")
    expect(manifest.description.length).toBeGreaterThan(0)
    expect(manifest.start_url).toBe("/")
    expect(manifest.scope).toBe("/")
    expect(manifest.display).toBe("standalone")
    expect(manifest.theme_color).toBe(THEME_COLOR)
    expect(manifest.background_color).toBe(BACKGROUND_COLOR)
    expect(manifest.theme_color).toBe("#0f1115")
    expect(manifest.categories).toContain("productivity")
    expect(manifest.lang).toBe("en")
  })

  it("declares every committed icon with a PNG type and the right sizes", () => {
    const { icons } = buildManifest()
    expect(icons).toHaveLength(ICON_FILES.length)
    for (const spec of ICON_FILES) {
      const icon = icons.find((entry) => entry.src === `icons/${spec.file}`)
      expect(icon, spec.file).toBeDefined()
      expect(icon?.sizes).toBe(`${spec.size}x${spec.size}`)
      expect(icon?.type).toBe("image/png")
      expect(icon?.purpose).toBe(spec.purpose === "maskable" ? "maskable" : undefined)
    }
    expect(icons.filter((entry) => entry.purpose === "maskable")).toHaveLength(1)
  })

  it("committed manifest matches the generator byte for byte", () => {
    expect(committed).toBe(manifestJson())
    const parsed = JSON.parse(committed) as WebAppManifest
    expect(parsed).toEqual(buildManifest())
  })

  it("is linked from index.html with its icons and theme color", () => {
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"')
    expect(html).toContain('name="theme-color" content="#0f1115"')
    expect(html).toContain('href="/icons/favicon-32.png"')
    expect(html).toContain('href="/icons/apple-touch-icon-180.png"')
  })
})
