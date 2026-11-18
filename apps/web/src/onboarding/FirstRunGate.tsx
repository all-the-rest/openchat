import type { ReactNode } from "react"
import { useCompletionOrNull } from "../chat/completion"
import { useSurfaceOrNull } from "../code/SurfaceProvider"
import { FirstRunCard } from "./FirstRunCard"

/**
 * Swaps the dead composer for the first-run card while no model is selectable.
 * `/api/info` is the authority: when it reports models, the card never shows,
 * even if one catalogue read failed. An unreachable host keeps the composer,
 * because the host banner's retry is the only useful action there.
 */
export function FirstRunGate({ children }: { children: ReactNode }) {
  const completion = useCompletionOrNull()
  const surface = useSurfaceOrNull()

  if (!completion?.loaded) return <>{children}</>
  if (surface?.hostReachable === false) return <>{children}</>
  if (surface?.modelsAvailable === true) return <>{children}</>
  // Wait for the info answer before deciding: a flash of onboarding on a
  // healthy deployment would be worse than a few extra milliseconds.
  if (surface !== null && surface.modelsAvailable === null) return <>{children}</>
  if (completion.models.length > 0) return <>{children}</>

  return <FirstRunCard />
}
