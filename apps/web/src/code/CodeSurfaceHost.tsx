import { lazy, Suspense, useEffect, useState } from "react"
import { useSurface } from "./SurfaceProvider"

const CodePage = lazy(() =>
  import("./CodePage").then((module) => ({ default: module.CodePage })),
)

/**
 * Hosts the Code surface outside the route switch, so navigating to Chat does
 * not unmount it. It mounts lazily on the first Code visit (a chat-only boot
 * never downloads the Code chunk) and then stays mounted: `active` only toggles
 * visibility, never the element's identity.
 *
 * The Code page itself is hidden via `hidden`, `inert` and `aria-hidden`, and
 * the iframe drops out of the tab order, so an invisible frame owns no focus
 * target while the owner is in Chat.
 */
export function CodeSurfaceHost({ active }: { active: boolean }) {
  const { configured } = useSurface()
  const [mounted, setMounted] = useState(active)

  // First visit wins: once Code was shown, the host stays for the session.
  useEffect(() => {
    if (active) setMounted(true)
  }, [active])

  if (!mounted || configured !== true) return null

  return (
    <Suspense
      fallback={
        <div
          data-testid="code-loading"
          hidden={!active}
          className={
            active ? "flex min-h-0 flex-1 items-center justify-center" : "hidden"
          }
        >
          <span className="loading loading-spinner loading-md" aria-hidden="true" />
        </div>
      }
    >
      <CodePage active={active} />
    </Suspense>
  )
}
