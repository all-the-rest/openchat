/**
 * Theme and interface language.
 *
 * Explicit ids keep the public `t("key")` API stable; the German text lives in
 * `src/locales/de/messages.po`.
 */
import { msg } from "@lingui/core/macro"

export const settings = {
  "theme.label": msg({ id: "theme.label", message: "Theme" }),
  "theme.toggleToLight": msg({ id: "theme.toggleToLight", message: "Switch to light theme" }),
  "theme.toggleToDark": msg({ id: "theme.toggleToDark", message: "Switch to dark theme" }),

  "language.label": msg({ id: "language.label", message: "Interface language" }),
  "language.en": msg({ id: "language.en", message: "English" }),
  "language.de": msg({ id: "language.de", message: "Deutsch" }),
} as const
