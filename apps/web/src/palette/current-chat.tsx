import { createContext, useContext, useEffect, useState, type ReactNode } from "react"

/**
 * What the command palette needs to know about the open chat. The chat page
 * owns the transcript, while the palette lives in the shell, so this small
 * context bridges the two without lifting the transcript into a global store.
 */
export interface PaletteChat {
  sessionID: string | null
  title: string
  /** Plain text of the newest assistant answer, or `null` when there is none. */
  lastAnswer: string | null
}

const EMPTY: PaletteChat = { sessionID: null, title: "", lastAnswer: null }

interface PaletteChatContextValue {
  value: PaletteChat
  publish: (next: PaletteChat) => void
}

const PaletteChatContext = createContext<PaletteChatContextValue | null>(null)

export function PaletteChatProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<PaletteChat>(EMPTY)
  return (
    <PaletteChatContext.Provider value={{ value, publish: setValue }}>
      {children}
    </PaletteChatContext.Provider>
  )
}

/** Safe outside the provider so a palette test need not mount the whole shell. */
export function usePaletteChat(): PaletteChat {
  return useContext(PaletteChatContext)?.value ?? EMPTY
}

/**
 * Called by the chat route on every transcript change. The cleanup clears the
 * value when the route unmounts, so the copy action never targets a chat the
 * owner has left.
 */
export function useReportPaletteChat(value: PaletteChat): void {
  const publish = useContext(PaletteChatContext)?.publish
  const { sessionID, title, lastAnswer } = value

  useEffect(() => {
    publish?.({ sessionID, title, lastAnswer })
  }, [publish, sessionID, title, lastAnswer])

  useEffect(() => {
    return () => publish?.(EMPTY)
  }, [publish])
}
