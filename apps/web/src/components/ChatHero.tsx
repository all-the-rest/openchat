import { useT } from "../i18n/provider"

export interface ChatHeroProps {
  /**
   * Heading level for the pitch. The landing page owns the page `h1`; an empty
   * chat already has a session title in its header, so it nests one level down.
   */
  level?: "h1" | "h2"
}

/**
 * Heading and one-line pitch shared by the landing page and an empty chat.
 * Both places start a conversation from the composer below, so the centred
 * treatment and the copy must not drift apart.
 */
export function ChatHero({ level = "h1" }: ChatHeroProps) {
  const t = useT()
  const Heading = level

  return (
    <div className="text-center">
      <Heading className="text-2xl font-semibold">{t("landing.heading")}</Heading>
      <p className="mt-2 text-sm text-muted">{t("landing.description")}</p>
    </div>
  )
}
