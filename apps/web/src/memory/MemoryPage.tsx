import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type {
  MemoryAuditRecord,
  MemoryFact,
  MemoryIndexResponse,
  MemoryStats,
} from "@openchat/contracts"
import { api } from "../api/client"
import { ErrorBanner } from "../components/ErrorBanner"
import { useI18n, useT } from "../i18n/provider"
import { AddFactForm } from "./AddFactForm"
import type { NewFact } from "./AddFactForm"
import { FactRow } from "./FactRow"
import type { FactEdit } from "./FactRow"
import { errorCode, memoryErrorKey } from "./errors"
import { auditLabel } from "./labels"

type LoadStatus = "loading" | "ready" | "error"

/**
 * `/memory` — the owner override on agent-managed memory. Facts are grouped by
 * topic, searchable, editable, deletable with a reason and exportable; the
 * index preview shows exactly what the next session receives.
 */
export function MemoryPage() {
  const t = useT()
  const { locale } = useI18n()
  const [status, setStatus] = useState<LoadStatus>("loading")
  const [facts, setFacts] = useState<MemoryFact[]>([])
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [index, setIndex] = useState<MemoryIndexResponse | null>(null)
  const [audit, setAudit] = useState<MemoryAuditRecord[]>([])
  const [query, setQuery] = useState("")
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(async (silent: boolean) => {
    if (!silent) setStatus("loading")
    try {
      const [list, preview, tail] = await Promise.all([
        api.memory(),
        api.memoryIndex(),
        api.memoryAudit(),
      ])
      if (!alive.current) return
      setFacts(list.facts)
      setStats(list.stats)
      setIndex(preview)
      setAudit(tail.entries)
      setStatus("ready")
    } catch {
      if (alive.current) setStatus("error")
    }
  }, [])

  useEffect(() => {
    void load(false)
  }, [load])

  const failure = (error: unknown): string => t(memoryErrorKey(errorCode(error)))
  const refresh = () => load(true)

  const add = async (input: NewFact): Promise<string | null> => {
    try {
      await api.createMemory({ ...input, tags: [] })
      await refresh()
      return null
    } catch (error) {
      return failure(error)
    }
  }

  const save = async (id: string, edit: FactEdit): Promise<string | null> => {
    try {
      await api.updateMemory(id, { ...edit, confirm: true })
      await refresh()
      return null
    } catch (error) {
      return failure(error)
    }
  }

  const remove = async (id: string, reason: string): Promise<string | null> => {
    try {
      await api.deleteMemory(id, reason)
      await refresh()
      return null
    } catch (error) {
      return failure(error)
    }
  }

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const visible = facts.filter((fact) => {
      if (needle.length === 0) return true
      return (
        fact.text.toLowerCase().includes(needle) ||
        fact.topic.toLowerCase().includes(needle) ||
        fact.tags.some((tag) => tag.toLowerCase().includes(needle))
      )
    })
    const byTopic = new Map<string, MemoryFact[]>()
    for (const fact of visible) {
      const list = byTopic.get(fact.topic) ?? []
      list.push(fact)
      byTopic.set(fact.topic, list)
    }
    return [...byTopic.entries()].sort(([left], [right]) => left.localeCompare(right))
  }, [facts, query])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
        <header className="flex flex-wrap items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h1 className="text-lg font-semibold">{t("memory.title")}</h1>
            <p className="text-sm text-muted">{t("memory.description")}</p>
          </div>
          <a
            data-testid="memory-export"
            className="btn btn-sm"
            href="/api/memory/export"
            download="openchat-memory.json"
          >
            {t("memory.export")}
          </a>
        </header>

        {status === "loading" ? (
          <div role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-muted">
            <span className="loading loading-spinner loading-sm" aria-hidden="true" />
            {t("memory.loading")}
          </div>
        ) : status === "error" ? (
          <div className="flex flex-col items-start gap-2">
            <ErrorBanner message={t("memory.loadFailed")} />
            <button type="button" className="btn btn-sm" onClick={() => void load(false)}>
              {t("memory.retry")}
            </button>
          </div>
        ) : (
          <>
            <p data-testid="memory-count" className="text-sm text-secondary">
              {t("memory.count", { count: stats?.active ?? 0 })}
            </p>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-secondary">{t("memory.search.label")}</span>
              <input
                data-testid="memory-search"
                type="search"
                className="input input-bordered w-full"
                value={query}
                placeholder={t("memory.search.placeholder")}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>

            <AddFactForm onAdd={add} />

            {facts.length === 0 ? (
              <p data-testid="memory-empty" className="text-sm text-muted">
                {t("memory.empty")}
              </p>
            ) : groups.length === 0 ? (
              <p data-testid="memory-search-empty" className="text-sm text-muted">
                {t("memory.search.empty")}
              </p>
            ) : (
              <div data-testid="memory-groups" className="flex flex-col gap-4">
                {groups.map(([topic, rows]) => (
                  <section key={topic} aria-labelledby={`memory-topic-${topic}`}>
                    <h2 id={`memory-topic-${topic}`} className="text-sm font-semibold">
                      {topic}
                    </h2>
                    <ul className="mt-2 flex flex-col gap-2">
                      {rows.map((fact) => (
                        <FactRow key={fact.id} fact={fact} onSave={save} onDelete={remove} />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}

            <details data-testid="memory-index" className="rounded-card border border-subtle bg-surface p-3">
              <summary className="cursor-pointer text-sm font-semibold">
                {t("memory.index.title")}{" "}
                <span className="text-xs font-normal text-muted">
                  {t("memory.index.tokens", { tokens: index?.tokens ?? 0 })}
                </span>
              </summary>
              <p className="mt-2 text-xs text-muted">{t("memory.index.hint")}</p>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-row bg-base-200 p-2 text-xs">
                {index?.index ?? ""}
              </pre>
            </details>

            <section aria-labelledby="memory-audit-heading" data-testid="memory-audit">
              <h2 id="memory-audit-heading" className="text-sm font-semibold">
                {t("memory.audit.title")}
              </h2>
              {audit.length === 0 ? (
                <p className="mt-1 text-sm text-muted">{t("memory.audit.empty")}</p>
              ) : (
                <ul className="mt-2 flex flex-col gap-1 text-xs text-secondary">
                  {audit.slice(-20).map((entry, position) => (
                    <li key={`${entry.at}-${String(position)}`} className="flex flex-wrap gap-2">
                      <span className="font-medium">
                        {t("memory.audit.by", {
                          action: t(auditLabel[entry.action]),
                          actor: entry.actor,
                        })}
                      </span>
                      <span className="text-muted">
                        {new Date(entry.at).toLocaleString(locale)}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{entry.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}
