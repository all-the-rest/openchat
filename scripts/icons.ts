/**
 * Generates the committed PWA icon set from one clean-room SVG source.
 *
 * Run `pnpm run icons` after replacing `apps/web/assets/icon-source.svg`. The
 * script is deterministic (no timestamps, fixed PNG options) and fails loudly
 * when the source is missing or malformed. Generated PNGs and the manifest are
 * committed, so a plain checkout never needs sharp or a generation step.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import sharp from "sharp"
import { ICON_FILES, MANIFEST_PATH, manifestJson } from "./pwa-manifest.ts"

// `pnpm run icons` runs from the repo root; Vitest imports this module from the
// web workspace. Both resolve to the same repository root.
const CWD = process.cwd()
const ROOT = CWD.endsWith(`${sep}apps${sep}web`) ? resolve(CWD, "..", "..") : CWD

export const SOURCE_PATH = join(ROOT, "apps/web/assets/icon-source.svg")
export const ICONS_DIR = join(ROOT, "apps/web/public/icons")
export const MANIFEST_FILE = join(ROOT, "apps/web/public", MANIFEST_PATH)

export interface IconSpec {
  file: string
  size: number
  maskable: boolean
}

export const ICONS: readonly IconSpec[] = ICON_FILES.map(({ file, size, purpose }) => ({
  file,
  size,
  maskable: purpose === "maskable",
}))

/** Reads the one source file, or stops with an actionable error. */
export function readSource(path: string = SOURCE_PATH): string {
  if (!existsSync(path)) {
    throw new Error(`icon source missing: ${path} — restore it or replace it with a 1024px SVG`)
  }
  const svg = readFileSync(path, "utf8")
  if (!svg.includes("<svg") || !/<rect id="surface"/.test(svg)) {
    throw new Error(`icon source is not a valid source SVG: ${path}`)
  }
  return svg
}

/**
 * Maskable icons must be opaque to the edge and keep the mark inside the
 * safe zone. Only the surface rectangle's corner radius changes; the mark
 * itself is identical to the regular 512 px render.
 */
export function maskableSource(svg: string): string {
  const rect = /<rect id="surface"[^>]*>/.exec(svg)?.[0]
  if (rect === undefined || !rect.includes('rx="220"')) {
    throw new Error("icon source must have <rect id=\"surface\" ... rx=\"220\"> for maskable output")
  }
  return svg.replace(rect, rect.replace('rx="220"', 'rx="0"'))
}

/** Rasterises one size from the shared source; identical input gives identical bytes. */
export async function renderIcon(svg: string, spec: IconSpec): Promise<Buffer> {
  const input = spec.maskable ? maskableSource(svg) : svg
  return await sharp(Buffer.from(input), { density: 72 })
    .resize(spec.size, spec.size, { fit: "contain" })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

/** Fresh render of every committed icon, keyed by file name. */
export async function renderIcons(): Promise<Map<string, Buffer>> {
  const svg = readSource()
  const rendered = new Map<string, Buffer>()
  for (const spec of ICONS) rendered.set(spec.file, await renderIcon(svg, spec))
  return rendered
}

export async function main(): Promise<void> {
  const rendered = await renderIcons()
  mkdirSync(ICONS_DIR, { recursive: true })
  for (const [name, bytes] of rendered) {
    writeFileSync(join(ICONS_DIR, name), bytes)
  }
  writeFileSync(MANIFEST_FILE, manifestJson())
  console.log(`icons: wrote ${rendered.size} PNGs and ${MANIFEST_PATH}`)
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("/scripts/icons.ts") === true
if (invokedDirectly) await main()
