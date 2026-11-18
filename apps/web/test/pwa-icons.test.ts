import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"
import { describe, expect, it } from "vitest"
import { ICONS, ICONS_DIR, readSource, renderIcons } from "../../../scripts/icons.ts"

describe("generated PWA icons", () => {
  it("commits every icon at its declared PNG dimensions", async () => {
    for (const spec of ICONS) {
      const bytes = readFileSync(join(ICONS_DIR, spec.file))
      const meta = await sharp(bytes).metadata()
      expect(meta.format, spec.file).toBe("png")
      expect(meta.width, spec.file).toBe(spec.size)
      expect(meta.height, spec.file).toBe(spec.size)
    }
  })

  it("renders byte-identical PNGs from the one source (no timestamps)", async () => {
    const fresh = await renderIcons()
    for (const spec of ICONS) {
      const committed = readFileSync(join(ICONS_DIR, spec.file))
      expect(fresh.get(spec.file)?.equals(committed), spec.file).toBe(true)
    }
  })

  it("has no transparency in the maskable variant", async () => {
    const bytes = readFileSync(join(ICONS_DIR, "icon-maskable-512.png"))
    const { data } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    let firstTransparent = -1
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] !== 255) {
        firstTransparent = index
        break
      }
    }
    expect(firstTransparent).toBe(-1)
  })

  it("fails loudly when the source is missing or malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "openchat-icons-"))
    expect(() => readSource(join(dir, "missing.svg"))).toThrow(/icon source missing/)
    const bad = join(dir, "bad.svg")
    writeFileSync(bad, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>')
    expect(() => readSource(bad)).toThrow(/not a valid source SVG/)
  })
})
