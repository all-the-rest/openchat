import type { EventEnvelope } from "@openchat/contracts"
import { EVENT } from "@openchat/contracts"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"

export type EventListener = (event: EventEnvelope) => void
export type ConnectionState = "connecting" | "open" | "closed"

export interface EventStreamValue {
  connection: ConnectionState
  /**
   * Increments every time the EventSource reconnects after its first open.
   * Consumers use it to resynchronize state that may have changed while the
   * stream was down (spec 10 M).
   */
  reconnect: number
  subscribe: (listener: EventListener) => () => void
}

const EventStreamContext = createContext<EventStreamValue | null>(null)

const NAMED_EVENTS: string[] = Object.values(EVENT)

function isEnvelope(value: unknown): value is EventEnvelope {
  if (value === null || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.type === "string" &&
    typeof candidate.id === "string" &&
    typeof candidate.created === "number" &&
    candidate.data !== null &&
    typeof candidate.data === "object"
  )
}

/**
 * One EventSource per authenticated session (spec 03). The BFF may send
 * unnamed SSE messages or named events; both are decoded into the same
 * envelope shape.
 */
export function EventStreamProvider({ children }: { children: ReactNode }) {
  const listeners = useRef<Set<EventListener>>(new Set())
  const [connection, setConnection] = useState<ConnectionState>("connecting")
  const [reconnect, setReconnect] = useState(0)

  useEffect(() => {
    if (typeof EventSource === "undefined") return

    const source = new EventSource("/api/events")
    let opens = 0

    const handle = (message: MessageEvent) => {
      if (typeof message.data !== "string") return
      let parsed: unknown
      try {
        parsed = JSON.parse(message.data)
      } catch {
        return
      }
      if (!isEnvelope(parsed)) return
      for (const listener of listeners.current) listener(parsed)
    }

    const typedHandle = handle as EventListenerFunction
    source.addEventListener("open", () => {
      setConnection("open")
      opens += 1
      // The first open is the initial connection; later ones are reconnects.
      if (opens > 1) setReconnect((count) => count + 1)
    })
    source.addEventListener("error", () => setConnection("closed"))
    source.addEventListener("message", typedHandle)
    for (const type of NAMED_EVENTS) source.addEventListener(type, typedHandle)

    return () => {
      source.removeEventListener("message", typedHandle)
      for (const type of NAMED_EVENTS) source.removeEventListener(type, typedHandle)
      source.close()
    }
  }, [])

  const subscribe = useCallback((listener: EventListener) => {
    listeners.current.add(listener)
    return () => {
      listeners.current.delete(listener)
    }
  }, [])

  return (
    <EventStreamContext.Provider value={{ connection, reconnect, subscribe }}>
      {children}
    </EventStreamContext.Provider>
  )
}

type EventListenerFunction = (event: Event) => void

export function useEventStream(): EventStreamValue {
  const value = useContext(EventStreamContext)
  if (!value) throw new Error("useEventStream must be used inside EventStreamProvider")
  return value
}
