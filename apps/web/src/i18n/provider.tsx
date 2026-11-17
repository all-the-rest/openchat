import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import {
  LOCALE_STORAGE_KEY,
  resolveLocale,
  translate,
  type Locale,
  type MessageKey,
  type MessageVars,
} from "./index"

export interface I18nValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: MessageKey, vars?: MessageVars) => string
}

const I18nContext = createContext<I18nValue | null>(null)

export interface I18nProviderProps {
  children: ReactNode
  /** Test and bootstrap override; falls back to the persisted setting. */
  initialLocale?: Locale
}

export function I18nProvider({ children, initialLocale }: I18nProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(() => initialLocale ?? resolveLocale())

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next)
    } catch {
      // Persisting is best effort; the UI still switches.
    }
  }, [])

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const t = useCallback(
    (key: MessageKey, vars?: MessageVars) => translate(locale, key, vars),
    [locale],
  )

  const value = useMemo<I18nValue>(() => ({ locale, setLocale, t }), [locale, setLocale, t])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext)
  if (!value) throw new Error("useI18n must be used inside I18nProvider")
  return value
}

export function useT(): I18nValue["t"] {
  return useI18n().t
}
