import { useT } from "../i18n/provider"
import { useSurface } from "./SurfaceProvider"
import type { Surface } from "./surface"

const OPTIONS: readonly Surface[] = ["chat", "code"]

/**
 * The Chat | Code segmented control (spec 13). Real buttons with
 * `aria-pressed`, not links: the pressed state follows the route, so a deep
 * link to `/code` shows Code as active without reading storage.
 */
export function SurfaceSwitch({ className = "" }: { className?: string }) {
  const t = useT()
  const { configured, surface, choose } = useSurface()

  if (configured !== true) return null

  return (
    <div
      role="group"
      aria-label={t("surface.label")}
      data-testid="surface-switch"
      className={`join shrink-0 rounded-row border border-subtle bg-surface ${className}`.trim()}
    >
      {OPTIONS.map((option, index) => (
        <button
          key={option}
          type="button"
          data-testid={`surface-${option}`}
          aria-pressed={surface === option}
          onClick={() => choose(option)}
          className={`btn btn-sm join-item border-0 px-3 ${
            surface === option ? "btn-primary" : "btn-ghost"
          } ${index === OPTIONS.length - 1 ? "" : "border-e border-subtle"}`.trim()}
        >
          {t(option === "chat" ? "surface.chat" : "surface.code")}
        </button>
      ))}
    </div>
  )
}
