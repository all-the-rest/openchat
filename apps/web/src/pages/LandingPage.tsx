import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { Composer } from "../chat/Composer"
import { ConnectionNotice } from "../chat/ConnectionNotice"
import { NEW_DRAFT_KEY, clearDraft } from "../chat/drafts"
import { useSessions } from "../chat/sessions"
import { ChatHero } from "../components/ChatHero"
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
      // The prompt now belongs to a real session; the landing draft is done.
      clearDraft(NEW_DRAFT_KEY)
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
        <ChatHero />

        {failed ? (
          <ErrorBanner message={t("session.createFailed")} onDismiss={() => setFailed(false)} />
        ) : null}

        <ConnectionNotice />

        <Composer
          onSend={send}
          onStop={() => undefined}
          running={false}
          disabled={creating}
          draftKey={NEW_DRAFT_KEY}
          autoFocus
        />
      </div>
    </div>
  )
}
