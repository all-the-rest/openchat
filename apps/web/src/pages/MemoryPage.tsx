import type { MemoryAuditEntry, MemoryFact, MemorySource } from "@openchat/contracts"
import { useCallback, useEffect, useState } from "react"
import { request } from "../api/transport"
import { useT } from "../i18n/provider"

/**
 * Memory text is untrusted data: it is always rendered as plain React text,
 * never as Markdown or HTML. The fact/audit shapes come from the shared API.
 */
interface MemoryResponse {
  facts: MemoryFact[]
  audit: MemoryAuditEntry[]
  index: string
}

type T = ReturnType<typeof useT>

function statusLabel(t: T, value: string): string {
  switch (value) {
    case "active":
      return t("memory.status.active")
    case "superseded":
      return t("memory.status.superseded")
    case "expired":
      return t("memory.status.expired")
    case "deleted":
      return t("memory.status.deleted")
    default:
      return value
  }
}

function trustLabel(t: T, value: string): string {
  switch (value) {
    case "explicit":
      return t("memory.trust.explicit")
    case "observed":
      return t("memory.trust.observed")
    case "inferred":
      return t("memory.trust.inferred")
    default:
      return value
  }
}

function sourceLabel(source: MemorySource | undefined): string {
  if (!source) return ""
  return [source.sessionID, source.messageID, source.at].filter(Boolean).join(" · ")
}

function Th({ label }: { label: string }) {
  return <th scope="col" className="px-2 py-1 text-start">{label}</th>
}

/** One fact: metadata columns, plain-text body and inline edit/delete controls. */
function FactRow({ fact, onChanged }: { fact: MemoryFact; onChanged: () => void }) {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(fact.text)
  const [topic, setTopic] = useState(fact.topic ?? "")
  const [deleting, setDeleting] = useState(false)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await request<MemoryFact>(`/api/memory/${encodeURIComponent(fact.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ text, topic }),
      })
      setEditing(false)
      onChanged()
    } catch {
      setError(t("memory.saveFailed"))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (busy || !reason.trim()) return
    setBusy(true)
    setError(null)
    try {
      await request(`/api/memory/${encodeURIComponent(fact.id)}`, {
        method: "DELETE",
        body: JSON.stringify({ reason: reason.trim() }),
      })
      onChanged()
    } catch {
      setError(t("memory.deleteFailed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <tr data-testid="memory-row" className="border-b border-subtle align-top text-sm">
      <td className="px-2 py-2 font-mono text-xs">{fact.id}</td>
      <td className="px-2 py-2">{fact.kind}</td>
      <td className="px-2 py-2">{editing ? topic : fact.topic}</td>
      <td className="px-2 py-2">{statusLabel(t, fact.status)}</td>
      <td className="px-2 py-2">{trustLabel(t, fact.trust)}</td>
      <td className="max-w-md px-2 py-2">
        {editing ? (
          <div className="flex flex-col gap-2">
            <label htmlFor={`memory-text-${fact.id}`} className="sr-only">
              {t("memory.textLabel")}
            </label>
            <textarea
              id={`memory-text-${fact.id}`}
              data-testid="memory-edit-text"
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={3}
              className="w-full rounded-row border border-subtle bg-surface p-2 text-sm"
            />
            <label htmlFor={`memory-topic-${fact.id}`} className="sr-only">
              {t("memory.topicLabel")}
            </label>
            <input
              id={`memory-topic-${fact.id}`}
              data-testid="memory-edit-topic"
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              className="w-full rounded-row border border-subtle bg-surface px-2 py-1 text-sm"
            />
          </div>
        ) : (
          // Plain text only: React escapes children, so no Markdown/HTML runs.
          <span data-testid="memory-text" className="whitespace-pre-wrap break-words">
            {fact.text}
          </span>
        )}
      </td>
      <td className="px-2 py-2 text-xs text-muted" data-testid="memory-source">
        {sourceLabel(fact.source)}
      </td>
      <td className="px-2 py-2 text-xs text-muted">{fact.createdAt ?? ""}</td>
      <td className="px-2 py-2 text-xs text-muted">{fact.lastConfirmedAt ?? ""}</td>
      <td className="px-2 py-2">
        <div className="flex flex-col items-start gap-2">
          {editing ? (
            <>
              <button
                type="button"
                data-testid="memory-save"
                onClick={() => void save()}
                disabled={busy}
                className="btn btn-primary btn-xs"
              >
                {t("memory.save")}
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                disabled={busy}
                className="btn btn-ghost btn-xs"
              >
                {t("memory.cancel")}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                data-testid="memory-edit"
                onClick={() => setEditing(true)}
                className="btn btn-ghost btn-xs"
              >
                {t("memory.edit")}
              </button>
              <button
                type="button"
                data-testid="memory-delete-toggle"
                onClick={() => setDeleting(true)}
                className="btn btn-ghost btn-xs text-error"
              >
                {t("memory.delete")}
              </button>
            </>
          )}
          {deleting ? (
            <div className="flex flex-col gap-2 rounded-row border border-subtle p-2">
              <label htmlFor={`memory-reason-${fact.id}`} className="text-xs text-secondary">
                {t("memory.deleteReasonLabel")}
              </label>
              <input
                id={`memory-reason-${fact.id}`}
                type="text"
                data-testid="memory-delete-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder={t("memory.deleteReasonPlaceholder")}
                className="w-full rounded-row border border-subtle bg-surface px-2 py-1 text-sm"
              />
              <button
                type="button"
                data-testid="memory-delete"
                onClick={() => void remove()}
                disabled={busy || reason.trim().length === 0}
                className="btn btn-error btn-xs"
              >
                {t("memory.deleteConfirm")}
              </button>
              <button
                type="button"
                onClick={() => setDeleting(false)}
                disabled={busy}
                className="btn btn-ghost btn-xs"
              >
                {t("memory.cancel")}
              </button>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-error">
              {error}
            </p>
          ) : null}
        </div>
      </td>
    </tr>
  )
}

/** Audit trail: every mutation with its actor, time and reason. */
function AuditView({ entries }: { entries: MemoryAuditEntry[] }) {
  const t = useT()
  return (
    <section data-testid="memory-audit" aria-label={t("memory.auditHeading")} className="mt-8">
      <h2 className="text-sm font-semibold text-secondary">{t("memory.auditHeading")}</h2>
      {entries.length === 0 ? (
        <p className="mt-2 text-sm text-muted">{t("memory.audit.empty")}</p>
      ) : (
        <table className="mt-2 w-full border-collapse text-start text-sm">
          <thead>
            <tr className="border-b border-subtle text-start text-xs uppercase text-muted">
              <Th label={t("memory.audit.time")} />
              <Th label={t("memory.audit.actor")} />
              <Th label={t("memory.audit.action")} />
              <Th label={t("memory.audit.fact")} />
              <Th label={t("memory.audit.reason")} />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, index) => (
              <tr key={`${entry.at}-${index}`} className="border-b border-subtle">
                <td className="px-2 py-1 text-xs text-muted">{entry.at}</td>
                <td className="px-2 py-1">{entry.actor}</td>
                <td className="px-2 py-1">{entry.action}</td>
                <td className="px-2 py-1 font-mono text-xs">{entry.ids.join(", ")}</td>
                <td className="px-2 py-1">{entry.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

/** `/memory` inside the app shell: browse, override, audit and export. */
export function MemoryPage() {
  const t = useT()
  const [facts, setFacts] = useState<MemoryFact[]>([])
  const [audit, setAudit] = useState<MemoryAuditEntry[]>([])
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")

  const load = useCallback((showLoading: boolean) => {
    if (showLoading) setStatus("loading")
    return request<MemoryResponse>("/api/memory").then(
      (response) => {
        setFacts(response.facts ?? [])
        setAudit(response.audit ?? [])
        setStatus("ready")
      },
      () => setStatus("error"),
    )
  }, [])

  useEffect(() => {
    void load(true)
  }, [load])

  const onChanged = () => {
    void load(false)
  }

  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6">
      <h1 className="text-xl font-semibold">{t("memory.title")}</h1>
      <p className="mt-1 text-sm text-muted">{t("memory.description")}</p>

      <div className="mt-4 flex items-center gap-2">
        <a
          href="/api/memory/export"
          download
          data-testid="memory-export"
          className="btn btn-outline btn-sm"
        >
          {t("memory.export")}
        </a>
      </div>

      {status === "loading" ? (
        <div data-testid="memory-loading" className="mt-6 flex items-center gap-2 text-sm text-muted">
          <span className="loading loading-spinner loading-sm" aria-hidden="true" />
          {t("memory.loading")}
        </div>
      ) : status === "error" ? (
        <div data-testid="memory-error" role="alert" className="mt-6 text-sm text-error">
          <p>{t("memory.loadFailed")}</p>
          <button
            type="button"
            onClick={() => void load(true)}
            className="btn btn-outline btn-sm mt-2"
          >
            {t("memory.retry")}
          </button>
        </div>
      ) : facts.length === 0 ? (
        <p data-testid="memory-empty" className="mt-6 text-sm text-muted">
          {t("memory.empty")}
        </p>
      ) : (
        <section aria-label={t("memory.factsHeading")} className="mt-6 overflow-x-auto">
          <h2 className="text-sm font-semibold text-secondary">{t("memory.factsHeading")}</h2>
          <table className="mt-2 w-full border-collapse text-start">
            <thead>
              <tr className="border-b border-subtle text-xs uppercase text-muted">
                <Th label={t("memory.col.id")} />
                <Th label={t("memory.col.kind")} />
                <Th label={t("memory.col.topic")} />
                <Th label={t("memory.col.status")} />
                <Th label={t("memory.col.trust")} />
                <Th label={t("memory.col.text")} />
                <Th label={t("memory.col.source")} />
                <Th label={t("memory.col.created")} />
                <Th label={t("memory.col.confirmed")} />
                <Th label={t("memory.col.actions")} />
              </tr>
            </thead>
            <tbody>
              {facts.map((fact) => (
                <FactRow key={fact.id} fact={fact} onChanged={onChanged} />
              ))}
            </tbody>
          </table>
        </section>
      )}

      {status === "ready" ? <AuditView entries={audit} /> : null}
    </div>
  )
}
