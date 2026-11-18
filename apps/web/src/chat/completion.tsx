import type { AgentInfo, ModelInfo } from "@openchat/contracts"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { api } from "../api/client"

/** Per-browser default for every new chat; a chat never overrides it. */
export const COMPLETION_STORAGE_KEY = "openchat.completion"

export interface Completion {
  model: string | null
  agent: string | null
}

const EMPTY: Completion = { model: null, agent: null }

export function readCompletion(): Completion {
  try {
    const raw = window.localStorage.getItem(COMPLETION_STORAGE_KEY)
    if (!raw) return { ...EMPTY }
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== "object") return { ...EMPTY }
    const record = value as Record<string, unknown>
    return {
      model: typeof record.model === "string" && record.model ? record.model : null,
      agent: typeof record.agent === "string" && record.agent ? record.agent : null,
    }
  } catch {
    return { ...EMPTY }
  }
}

/** Best effort: private browsing may refuse storage without failing the UI. */
export function writeCompletion(value: Completion): void {
  try {
    window.localStorage.setItem(COMPLETION_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // The in-memory choice still applies to this tab.
  }
}

export interface CompletionValue extends Completion {
  models: ModelInfo[]
  agents: AgentInfo[]
  /** False until `/api/models` and `/api/agents` have both settled. */
  loaded: boolean
  setModel: (model: string | null) => void
  setAgent: (agent: string | null) => void
}

const CompletionContext = createContext<CompletionValue | null>(null)

export interface CompletionProviderProps {
  children: ReactNode
  /** Test/bootstrap override; falls back to the persisted browser choice. */
  initial?: Completion
  /** Injected catalogues; skips the network in isolated component tests. */
  catalogue?: { models: ModelInfo[]; agents: AgentInfo[] }
}

export function CompletionProvider({ children, initial, catalogue }: CompletionProviderProps) {
  const [choice, setChoice] = useState<Completion>(() => initial ?? readCompletion())
  const [models, setModels] = useState<ModelInfo[]>(catalogue?.models ?? [])
  const [agents, setAgents] = useState<AgentInfo[]>(catalogue?.agents ?? [])
  const [loaded, setLoaded] = useState(catalogue !== undefined)

  useEffect(() => {
    if (catalogue) return
    let active = true
    void Promise.allSettled([api.models(), api.agents()]).then(([foundModels, foundAgents]) => {
      if (!active) return
      if (foundModels.status === "fulfilled") setModels(foundModels.value)
      if (foundAgents.status === "fulfilled") setAgents(foundAgents.value)
      setLoaded(true)
    })
    return () => {
      active = false
    }
  }, [catalogue])

  const setModel = useCallback((model: string | null) => {
    setChoice((current) => {
      const next = { ...current, model }
      writeCompletion(next)
      return next
    })
  }, [])

  const setAgent = useCallback((agent: string | null) => {
    setChoice((current) => {
      const next = { ...current, agent }
      writeCompletion(next)
      return next
    })
  }, [])

  const value = useMemo<CompletionValue>(
    () => ({ ...choice, models, agents, loaded, setModel, setAgent }),
    [choice, models, agents, loaded, setModel, setAgent],
  )

  return <CompletionContext.Provider value={value}>{children}</CompletionContext.Provider>
}

export function useCompletion(): CompletionValue {
  const value = useContext(CompletionContext)
  if (!value) throw new Error("useCompletion must be used inside CompletionProvider")
  return value
}

/** Leaf hooks (chat session, isolated tests) work without a provider. */
export function useCompletionOrNull(): CompletionValue | null {
  return useContext(CompletionContext)
}
