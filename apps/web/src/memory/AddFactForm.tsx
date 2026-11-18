import { useState } from "react"
import { MEMORY_TRUSTS } from "@openchat/contracts"
import type { MemoryTrust } from "@openchat/contracts"
import { useT } from "../i18n/provider"
import { trustLabel } from "./labels"

export interface NewFact {
  text: string
  topic: string
  trust: MemoryTrust
}

/** The owner's explicit write path; the agent writes through its MCP tool. */
export function AddFactForm({
  onAdd,
}: {
  onAdd: (input: NewFact) => Promise<string | null>
}) {
  const t = useT()
  const [text, setText] = useState("")
  const [topic, setTopic] = useState("")
  const [trust, setTrust] = useState<MemoryTrust>("explicit")
  const [error, setError] = useState<string | null>(null)
  const [validation, setValidation] = useState(false)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (text.trim().length === 0 || topic.trim().length === 0) {
      setValidation(true)
      return
    }
    setValidation(false)
    setBusy(true)
    setError(null)
    try {
      const failure = await onAdd({ text: text.trim(), topic: topic.trim(), trust })
      if (failure) {
        setError(failure)
        return
      }
      setText("")
      setTopic("")
      setTrust("explicit")
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-labelledby="memory-add-heading"
      data-testid="memory-add"
      className="rounded-card border border-subtle bg-surface p-4"
    >
      <h2 id="memory-add-heading" className="text-base font-semibold">
        {t("memory.add.title")}
      </h2>
      <form
        className="mt-3 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-secondary">{t("memory.add.text")}</span>
          <textarea
            data-testid="memory-add-text"
            className="textarea textarea-bordered min-h-20 w-full"
            value={text}
            maxLength={2000}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <div className="flex flex-wrap gap-3">
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm">
            <span className="text-secondary">{t("memory.add.topic")}</span>
            <input
              data-testid="memory-add-topic"
              className="input input-bordered w-full"
              value={topic}
              maxLength={80}
              placeholder={t("memory.add.topicPlaceholder")}
              onChange={(event) => setTopic(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-secondary">{t("memory.add.trust")}</span>
            <select
              data-testid="memory-add-trust"
              className="select select-bordered"
              value={trust}
              onChange={(event) => setTrust(event.target.value as MemoryTrust)}
            >
              {MEMORY_TRUSTS.map((value) => (
                <option key={value} value={value}>
                  {t(trustLabel[value])}
                </option>
              ))}
            </select>
          </label>
        </div>
        {validation ? (
          <p role="alert" className="text-sm text-error">
            {t("memory.validation.required")}
          </p>
        ) : null}
        {error ? (
          <p role="alert" data-testid="memory-add-error" className="text-sm text-error">
            {t("memory.add.failed", { reason: error })}
          </p>
        ) : null}
        <button
          type="submit"
          data-testid="memory-add-submit"
          className="btn btn-primary btn-sm self-start"
          disabled={busy}
        >
          {t("memory.add.submit")}
        </button>
      </form>
    </section>
  )
}
