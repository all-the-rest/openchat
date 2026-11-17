import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { Composer } from "../chat/Composer"
import { useSessions } from "../chat/sessions"
import { ErrorBanner } from "../components/ErrorBanner"
import { useT } from "../i18n/provider"

export function LandingPage() {
  const t = useT()
  const navigate = useNavigate()
  const { create } = useSessions()
  const [creating, setCreating] = useState(false)
  const [failed, setFailed] = useState(false)

  const send = async (text: string) => {
    setCreating(true)
    setFailed(false)
    try {
      const session = await create()
      navigate(`/c/${session.id}`, { state: { pendingPrompt: text } })
    } catch (error) {
      setFailed(true)
      throw error
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[768px] flex-1 flex-col justify-center gap-6 px-4 py-10">
        <div className="text-center">
          <h1 className="text-2xl font-semibold">{t("landing.heading")}</h1>
          <p className="mt-2 text-sm text-muted">{t("landing.description")}</p>
        </div>

        {failed ? (
          <ErrorBanner message={t("session.createFailed")} onDismiss={() => setFailed(false)} />
        ) : null}

        <Composer
          onSend={send}
          onStop={() => undefined}
          running={false}
          disabled={creating}
          autoFocus
        />
      </div>
    </div>
  )
}
