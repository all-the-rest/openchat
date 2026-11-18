import { useState } from "react"
import { Link } from "react-router-dom"
import { MEMORY_TRUSTS } from "@openchat/contracts"
import type { MemoryFact, MemoryTrust } from "@openchat/contracts"
import { useI18n, useT } from "../i18n/provider"
import { statusLabel, trustLabel } from "./labels"

export interface FactEdit {
  text: string
  trust: MemoryTrust
}

/** One fact with its provenance, inline edit and a reason-bearing delete. */
export function FactRow({
  fact,
  onSave,
  onDelete,
}: {
  fact: MemoryFact
  onSave: (id: string, edit: FactEdit) => Promise<string | null>
  onDelete: (id: string, reason: string) => Promise<string | null>
}) {
  const t = useT()
  const { locale } = useI18n()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(fact.text)
  const [trust, setTrust] = useState<MemoryTrust>(fact.trust)
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const date = (iso: string) => new Date(iso).toLocaleDateString(locale)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const failure = await onSave(fact.id, { text: text.trim(), trust })
      if (failure) {
        setError(failure)
        return
      }
      setEditing(false)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (reason.trim().length === 0) {
      setError(t("memory.validation.reason"))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const failure = await onDelete(fact.id, reason.trim())
      if (failure) setError(failure)
    } finally {
      setBusy(false)
    }
  }

  return (
    <li
      data-testid="memory-fact"
      data-topic={fact.topic}
      className="rounded-row border border-subtle bg-surface px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="badge badge-sm border-subtle text-secondary">{fact.topic}</span>
        <span data-testid="memory-fact-trust" className="text-muted">
          {t(trustLabel[fact.trust])}
        </span>
        {fact.status !== "active" ? (
          <span className="badge badge-sm badge-warning">{t(statusLabel[fact.status])}</span>
        ) : null}
        <span className="flex-1" />
        <button
          type="button"
          data-testid="memory-fact-edit"
          aria-label={t("memory.fact.edit", { topic: fact.topic })}
          className="btn btn-ghost btn-xs"
          onClick={() => setEditing((open) => !open)}
        >
          {t("memory.fact.edit", { topic: fact.topic })}
        </button>
        <button
          type="button"
          data-testid="memory-fact-delete"
          aria-label={t("memory.fact.delete", { topic: fact.topic })}
          className="btn btn-ghost btn-xs text-error"
          onClick={() => setConfirming((open) => !open)}
        >
          {t("memory.fact.delete", { topic: fact.topic })}
        </button>
      </div>

      {editing ? (
        <div className="mt-2 flex flex-col gap-2">
          <textarea
            data-testid="memory-edit-text"
            className="textarea textarea-bordered min-h-20 w-full"
            value={text}
            maxLength={2000}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="flex items-center gap-2">
            <select
              data-testid="memory-edit-trust"
              className="select select-bordered select-sm"
              value={trust}
              onChange={(event) => setTrust(event.target.value as MemoryTrust)}
            >
              {MEMORY_TRUSTS.map((value) => (
                <option key={value} value={value}>
                  {t(trustLabel[value])}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-primary btn-xs" disabled={busy} onClick={() => void save()}>
              {t("memory.fact.save")}
            </button>
            <button type="button" className="btn btn-ghost btn-xs" onClick={() => setEditing(false)}>
              {t("memory.fact.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <p data-testid="memory-fact-text" className="mt-1 whitespace-pre-wrap text-sm">
          {fact.text}
        </p>
      )}

      {confirming ? (
        <div className="mt-2 rounded-row border border-error/40 p-2">
          <p className="text-sm text-secondary">{t("memory.fact.deleteConfirm")}</p>
          <input
            data-testid="memory-delete-reason"
            className="input input-bordered input-sm mt-2 w-full"
            value={reason}
            maxLength={500}
            placeholder={t("memory.fact.deleteReason")}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              data-testid="memory-delete-submit"
              className="btn btn-error btn-xs"
              disabled={busy}
              onClick={() => void remove()}
            >
              {t("memory.fact.deleteSubmit")}
            </button>
            <button type="button" className="btn btn-ghost btn-xs" onClick={() => setConfirming(false)}>
              {t("memory.fact.deleteCancel")}
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-sm text-error">
          {error}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted">
        <span>{t("memory.fact.created", { when: date(fact.createdAt) })}</span>
        <span>{t("memory.fact.confirmed", { when: date(fact.lastConfirmedAt) })}</span>
        {fact.expiresAt ? (
          <span>{t("memory.fact.expires", { when: date(fact.expiresAt) })}</span>
        ) : null}
        {fact.source.sessionID ? (
          <Link
            data-testid="memory-fact-source"
            className="link link-hover"
            to={`/c/${encodeURIComponent(fact.source.sessionID)}`}
          >
            {t("memory.fact.source")}
          </Link>
        ) : null}
      </div>
    </li>
  )
}
