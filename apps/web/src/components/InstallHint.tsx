import { useEffect, useState } from "react"
import { useT } from "../i18n/provider"
import { useMediaQuery } from "../lib/useMediaQuery"

/** The Chromium install prompt; absent on browsers that cannot install. */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

const DISMISS_KEY = "openchat.installDismissed"
const STANDALONE_QUERY = "(display-mode: standalone)"

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "1"
  } catch {
    return false
  }
}

function rememberDismissed(): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, "1")
  } catch {
    // Best effort: the hint stays dismissed for this page view regardless.
  }
}

/**
 * A dismissible hint shown only after a real `beforeinstallprompt` event. There
 * is no synthetic install button: unsupported browsers and standalone windows
 * render nothing. The browser owns the actual install UI via `event.prompt()`.
 */
export function InstallHint() {
  const t = useT()
  const standalone =
    useMediaQuery(STANDALONE_QUERY) ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null)
  const [dismissed, setDismissed] = useState(readDismissed)

  useEffect(() => {
    if (standalone) return
    const onBeforeInstall = (event: Event) => {
      event.preventDefault()
      // A deliberate dismissal is sticky; a later prompt event must not bring
      // the hint back unless the browser itself starts a new install flow.
      setPrompt(event as InstallPromptEvent)
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstall)
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstall)
  }, [standalone])

  if (standalone || dismissed || !prompt) return null

  const dismiss = () => {
    rememberDismissed()
    setDismissed(true)
  }
  const install = () => {
    const current = prompt
    setPrompt(null)
    setDismissed(true)
    rememberDismissed()
    void current.prompt().then(() => current.userChoice).catch(() => {})
  }

  return (
    <div
      role="status"
      data-testid="install-hint"
      className="flex shrink-0 items-center gap-2 border-b border-subtle bg-elevated px-4 py-2 text-xs"
    >
      <span className="min-w-0 flex-1">{t("install.hint")}</span>
      <button type="button" onClick={install} className="btn btn-primary btn-xs shrink-0">
        {t("install.install")}
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t("install.dismiss")}
        data-testid="install-dismiss"
        className="btn btn-ghost btn-xs shrink-0"
      >
        ×
      </button>
    </div>
  )
}
