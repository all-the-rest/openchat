/**
 * Lingui configuration for the web app.
 *
 * Message ids are explicit and equal to the `t("key")` keys used by the UI, so
 * extraction never renames a call site. Catalogs stay in gettext PO files;
 * `i18n:compile` writes the committed TypeScript bundle next to them, and the
 * drift gate in `scripts/lint-i18n.ts` rejects stale output.
 */
import { defineConfig } from "@lingui/cli"
import { formatter } from "@lingui/format-po"

export default defineConfig({
  sourceLocale: "en",
  locales: ["en", "de"],
  catalogs: [
    {
      path: "src/locales/{locale}/messages",
      include: ["src"],
    },
  ],
  format: formatter({ lineNumbers: false }),
  compileNamespace: "ts",
})
