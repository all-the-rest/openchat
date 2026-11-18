/**
 * Single source of truth for the committed web app manifest.
 *
 * `scripts/icons.ts` derives the icon list here and writes the JSON into
 * `apps/web/public/manifest.webmanifest`, so the manifest and the generated PNG
 * set cannot drift apart. Name/description come from the compiled English
 * catalog (the `pwa.*` messages), not from a second copy of the text.
 */
import { I18n } from "@lingui/core"
import { messages as english } from "../apps/web/src/locales/en/messages.ts"

export const THEME_COLOR = "#0f1115"
export const BACKGROUND_COLOR = "#0f1115"
export const MANIFEST_PATH = "manifest.webmanifest"

export interface ManifestIcon {
  src: string
  sizes: string
  type: "image/png"
  purpose?: "any" | "maskable"
}

export interface WebAppManifest {
  name: string
  short_name: string
  description: string
  start_url: string
  scope: string
  display: "standalone"
  background_color: string
  theme_color: string
  categories: string[]
  lang: string
  icons: ManifestIcon[]
}

export const ICON_FILES = [
  { file: "icon-192.png", size: 192, purpose: "any" },
  { file: "icon-512.png", size: 512, purpose: "any" },
  { file: "icon-maskable-512.png", size: 512, purpose: "maskable" },
  { file: "apple-touch-icon-180.png", size: 180, purpose: "any" },
  { file: "favicon-16.png", size: 16, purpose: "any" },
  { file: "favicon-32.png", size: 32, purpose: "any" },
  { file: "favicon-48.png", size: 48, purpose: "any" },
] as const

/** Builds the manifest from the English catalog plus the icon file list. */
export function buildManifest(): WebAppManifest {
  const i18n = new I18n({ locale: "en", messages: { en: english } })
  return {
    name: i18n._("pwa.name"),
    short_name: i18n._("pwa.shortName"),
    description: i18n._("pwa.description"),
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: BACKGROUND_COLOR,
    theme_color: THEME_COLOR,
    categories: ["productivity", "utilities"],
    lang: "en",
    icons: ICON_FILES.map(({ file, size, purpose }) => ({
      src: `icons/${file}`,
      sizes: `${size}x${size}`,
      type: "image/png" as const,
      ...(purpose === "maskable" ? { purpose: "maskable" as const } : {}),
    })),
  }
}

/** Stable JSON with a trailing newline, safe to commit and compare in tests. */
export function manifestJson(): string {
  return `${JSON.stringify(buildManifest(), null, 2)}\n`
}
