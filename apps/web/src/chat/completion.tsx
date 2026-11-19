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
import {
  favoriteKey,
  readFavorites,
  writeFavorites,
  type ModelFavorite,
} from "./favorites"

/** Per-browser default for every new chat; a chat never overrides it. */
export const COMPLETION_STORAGE_KEY = "openchat.completion"

export interface Completion {
  model: string | null
  /** Selected variant of `model`, or `null` for the model default. */
  variant: string | null
  agent: string | null
}

const EMPTY: Completion = { model: null, variant: null, agent: null }

export function readCompletion(): Completion {
  try {
    const raw = window.localStorage.getItem(COMPLETION_STORAGE_KEY)
    if (!raw) return { ...EMPTY }
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== "object") return { ...EMPTY }
    const record = value as Record<string, unknown>
    return {
      model: typeof record.model === "string" && record.model ? record.model : null,
      variant:
        typeof record.variant === "string" && record.variant ? record.variant : null,
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

/** The model choice safe to send: unknown models and variants are dropped. */
export function completeModelValue(
  choice: Pick<Completion, "model" | "variant">,
  models: readonly ModelInfo[],
): { model: string | undefined; variant: string | undefined } {
  // An empty catalogue means the read failed, not that the stored model is
  // gone. Forward the choice and let the host guard reject a truly unknown id.
  if (models.length === 0) {
    return {
      model: choice.model ?? undefined,
      variant: choice.variant ?? undefined,
    }
  }
  const found = models.find((entry) => entry.id === choice.model)
  // A favourite whose model disappeared is never sent to the host.
  if (!found) return { model: undefined, variant: undefined }
  // A variant the model no longer offers is dropped from the switch.
  const variant =
    choice.variant && found.variants.includes(choice.variant) ? choice.variant : undefined
  return { model: found.id, variant }
}

export interface CompletionValue extends Completion {
  models: ModelInfo[]
  agents: AgentInfo[]
  /** False until `/api/models` and `/api/agents` have both settled. */
  loaded: boolean
  favorites: ModelFavorite[]
  /**
   * Re-reads the model catalogue through `/api/providers/status`. Used by the
   * first-run card after a connection; throws when the host does not answer.
   */
  refreshModels: () => Promise<ModelInfo[]>
  setModel: (model: string | null, variant?: string | null) => void
  setAgent: (agent: string | null) => void
  toggleFavorite: (favorite: ModelFavorite) => void
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
  const [favorites, setFavorites] = useState<ModelFavorite[]>(() => readFavorites())

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

  const setModel = useCallback((model: string | null, variant: string | null = null) => {
    setChoice((current) => {
      // The picker always passes the complete choice; a caller that names only
      // a model never carries the previous model's variant over.
      const next = { ...current, model, variant }
      writeCompletion(next)
      return next
    })
  }, [])

  const refreshModels = useCallback(async () => {
    const response = await api.providerStatus()
    setModels(response.models)
    return response.models
  }, [])

  const setAgent = useCallback((agent: string | null) => {
    setChoice((current) => {
      const next = { ...current, agent }
      writeCompletion(next)
      return next
    })
  }, [])

  const toggleFavorite = useCallback((favorite: ModelFavorite) => {
    setFavorites((current) => {
      const key = favoriteKey(favorite)
      const next = current.some((entry) => favoriteKey(entry) === key)
        ? current.filter((entry) => favoriteKey(entry) !== key)
        : [...current, favorite]
      writeFavorites(next)
      return next
    })
  }, [])

  const value = useMemo<CompletionValue>(
    () => ({
      ...choice, models, agents, loaded, favorites,
      refreshModels, setModel, setAgent, toggleFavorite,
    }),
    [choice, models, agents, loaded, favorites, refreshModels, setModel, setAgent, toggleFavorite],
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
