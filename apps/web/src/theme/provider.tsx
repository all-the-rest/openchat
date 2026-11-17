import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

export type Theme = "dark" | "light"

export const THEME_STORAGE_KEY = "openchat.theme"

const THEME_NAMES: Record<Theme, string> = {
  dark: "openchat",
  light: "openchat-light",
}

export interface ThemeValue {
  theme: Theme
  daisyTheme: string
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeValue | null>(null)

export function isTheme(value: unknown): value is Theme {
  return value === "dark" || value === "light"
}

/** Stored setting → prefers-color-scheme → dark (dark is the default). */
export function resolveTheme(): Theme {
  if (typeof window === "undefined") return "dark"
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (isTheme(stored)) return stored
  } catch {
    // Ignore unavailable storage.
  }
  if (typeof window.matchMedia === "function") {
    try {
      if (window.matchMedia("(prefers-color-scheme: light)").matches) return "light"
    } catch {
      // Ignore a malformed media query implementation.
    }
  }
  return "dark"
}

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return
  document.documentElement.dataset.theme = THEME_NAMES[theme]
  document.documentElement.style.colorScheme = theme
}

/** Called from main.tsx before the first render to avoid a theme flash. */
export function applyInitialTheme(): Theme {
  const theme = resolveTheme()
  applyTheme(theme)
  return theme
}

export interface ThemeProviderProps {
  children: ReactNode
  initialTheme?: Theme
}

export function ThemeProvider({ children, initialTheme }: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() => initialTheme ?? resolveTheme())

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    applyTheme(next)
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // Persisting is best effort.
    }
  }, [])

  const toggleTheme = useCallback(() => {
    setThemeState((current) => {
      const next: Theme = current === "dark" ? "light" : "dark"
      applyTheme(next)
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, next)
      } catch {
        // Persisting is best effort.
      }
      return next
    })
  }, [])

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const value = useMemo<ThemeValue>(
    () => ({ theme, daisyTheme: THEME_NAMES[theme], setTheme, toggleTheme }),
    [theme, setTheme, toggleTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error("useTheme must be used inside ThemeProvider")
  return value
}
