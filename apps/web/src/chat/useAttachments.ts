/**
 * Composer attachment state. A file is uploaded as soon as it is selected, so
 * a type/size/quota rejection happens before the prompt is sent. The chip keeps
 * the server's stored name because that is what the reference block must use.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { ChatFileInfo } from "@openchat/contracts"
import { api, ApiError } from "../api/client"

export interface Attachment {
  id: number
  name: string
  size: number
  status: "uploading" | "ready" | "error"
  /** Name returned by the server after normalisation and collision suffixes. */
  storedName?: string
  /** Stable BFF error code, mapped to i18n in the chip renderer. */
  errorCode?: string
}

function codeOf(error: unknown): string | undefined {
  return error instanceof ApiError ? error.code : undefined
}

export function useAttachments(sessionID: string | undefined, onUploaded: () => void) {
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const nextID = useRef(1)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // A route change reuses the composer; a chip from the previous chat must not
  // be referenced by a prompt in the new one.
  useEffect(() => {
    setAttachments([])
  }, [sessionID])

  const addFiles = useCallback(
    (files: readonly File[]) => {
      if (!sessionID || files.length === 0) return
      for (const file of files) {
        const id = nextID.current
        nextID.current += 1
        setAttachments((current) => [
          ...current,
          { id, name: file.name, size: file.size, status: "uploading" },
        ])
        void api
          .uploadChatFile(sessionID, file.name, file)
          .then((stored: ChatFileInfo) => {
            if (!alive.current) return
            setAttachments((current) =>
              current.map((item) =>
                item.id === id
                  ? { ...item, status: "ready", storedName: stored.name }
                  : item,
              ),
            )
            onUploaded()
          })
          .catch((error: unknown) => {
            if (!alive.current) return
            setAttachments((current) =>
              current.map((item) =>
                item.id === id
                  ? { ...item, status: "error", errorCode: codeOf(error) }
                  : item,
              ),
            )
          })
      }
    },
    [sessionID, onUploaded],
  )

  const remove = useCallback((id: number) => {
    setAttachments((current) => current.filter((item) => item.id !== id))
  }, [])

  /** Called after a successful send: ready chips are consumed, failed ones stay. */
  const clearSent = useCallback(() => {
    setAttachments((current) => current.filter((item) => item.status !== "ready"))
  }, [])

  const uploading = attachments.some((item) => item.status === "uploading")
  const storedNames = attachments.flatMap((item) =>
    item.status === "ready" && item.storedName ? [item.storedName] : [],
  )

  return { attachments, uploading, storedNames, addFiles, remove, clearSent }
}
