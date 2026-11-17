import type { Ref } from "react"
import { MenuIcon, MoonIcon, SunIcon } from "../components/icons"
import { useI18n, useT } from "../i18n/provider"
import { isLocale, type Locale } from "../i18n"
import { useTheme } from "../theme/provider"

export function ThemeToggle({ className = "" }: { className?: string }) {
  const t = useT()
  const { theme, toggleTheme } = useTheme()
  const label = theme === "dark" ? t("theme.toggleToLight") : t("theme.toggleToDark")

  return (
    <button
      type="button"
      data-testid="theme-toggle"
      onClick={toggleTheme}
      aria-label={label}
      title={label}
      className={`btn btn-ghost btn-sm btn-square ${className}`.trim()}
    >
      {theme === "dark" ? <SunIcon className="size-5" /> : <MoonIcon className="size-5" />}
    </button>
  )
}

export function LocaleSelect({ className = "" }: { className?: string }) {
  const t = useT()
  const { locale, setLocale } = useI18n()

  return (
    <select
      data-testid="locale-select"
      aria-label={t("language.label")}
      title={t("language.label")}
      value={locale}
      onChange={(event) => {
        const next: Locale = isLocale(event.target.value) ? event.target.value : locale
        setLocale(next)
      }}
      className={`select select-sm border border-subtle bg-surface ${className}`.trim()}
    >
      <option value="en">{t("language.en")}</option>
      <option value="de">{t("language.de")}</option>
    </select>
  )
}

export function SidebarToggle({
  open,
  onOpen,
  className = "",
  ref,
}: {
  open: boolean
  onOpen: () => void
  className?: string
  ref?: Ref<HTMLButtonElement>
}) {
  const t = useT()
  return (
    <button
      type="button"
      ref={ref}
      data-testid="sidebar-toggle"
      onClick={onOpen}
      aria-label={t("nav.openSidebar")}
      aria-expanded={open}
      aria-controls="app-sidebar"
      className={`btn btn-ghost btn-sm btn-square ${className}`.trim()}
    >
      <MenuIcon className="size-5" />
    </button>
  )
}
