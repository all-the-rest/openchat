import { useEffect, useId, useRef, useState } from "react"
import { useT } from "../i18n/provider"
import { copyText } from "../lib/clipboard"
import type { ArtifactResult } from "./bridge"

/** The clipboard acknowledgement stays for this long, then resets. */
const DRAFT_COPIED_MS = 2_000

/** Pretty-printed `data`, or `null` when the result carries none. */
export function resultData(result: ArtifactResult): string | null {
  if (result.data === undefined) return null
  try {
    return JSON.stringify(result.data, null, 2)
  } catch {
    return null
  }
}

let unserialisable = 0

/**
 * Content identity for a result. `postMessage` clones the payload, so every
 * delivery is a new object: comparing references would report a change for the
 * same content, and comparing JSON text is what the user actually sees.
 */
export function resultSignature(result: ArtifactResult): string {
  try {
    const json = JSON.stringify(result)
    return typeof json === "string" ? json : "null"
  } catch {
    // A caller could hand over a value the bridge would never accept; treat it
    // as its own result instead of claiming it is the one already on screen.
    unserialisable += 1
    return `unserialisable:${unserialisable}`
  }
}

interface Draft {
  title: string
  text: string
  /** Pretty-printed `data`; `null` when the result carried none. */
  data: string | null
}

function draftFrom(result: ArtifactResult, fallbackTitle: string): Draft {
  const title =
    typeof result.title === "string" && result.title.length > 0 ? result.title : fallbackTitle
  return {
    title,
    text: typeof result.text === "string" ? result.text : "",
    data: resultData(result),
  }
}

/** Title, body and data as one plain-text payload. */
export function draftClipboardText(draft: Draft): string {
  return [draft.title, draft.text, draft.data]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n\n")
}

/**
 * The editable draft under the artifact frame: the one place a bridge result
 * lands on `/artifacts/:id`. Title and body are `<input>`/`<textarea>` values,
 * the optional `data` is a `<pre>` of JSON. Nothing in a result is ever parsed
 * as HTML — an artifact's text stays text, exactly as the sandbox promises.
 *
 * There is no session and no composer on this route, so the panel offers only
 * Copy and Dismiss. An inline artifact card in a chat message is the surface
 * that would add "insert into the message"; that is a different component.
 */
export function DraftPanel({
  result,
  onDismiss,
}: {
  result: ArtifactResult
  onDismiss(): void
}) {
  const t = useT()
  const baseId = useId()
  const signature = resultSignature(result)
  const [draft, setDraft] = useState<Draft>(() => draftFrom(result, t("artifacts.draftTitleFallback")))
  const [source, setSource] = useState(signature)
  const [edited, setEdited] = useState(false)
  const [pending, setPending] = useState<{ result: ArtifactResult; signature: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    return () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current)
    }
  }, [])

  // Overwrite rule, deliberately strict about user edits: an untouched draft
  // follows the artifact (a calculator re-posts on every keystroke), while a
  // draft the user typed into keeps its text. A different result then only
  // raises the "new result available" affordance, which replaces on click; it
  // never arrives by itself. Dismiss unmounts the panel, so the next result
  // starts a fresh draft even when it is identical to the dismissed one.
  if (signature !== source) {
    if (!edited) {
      setDraft(draftFrom(result, t("artifacts.draftTitleFallback")))
      setSource(signature)
      setPending(null)
      setCopied(false)
    } else if (pending?.signature !== signature) {
      setPending({ result, signature })
    }
  }

  const copy = async () => {
    const ok = await copyText(draftClipboardText(draft))
    if (!ok) return
    setCopied(true)
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), DRAFT_COPIED_MS)
  }

  const replace = () => {
    if (!pending) return
    setDraft(draftFrom(pending.result, t("artifacts.draftTitleFallback")))
    setSource(pending.signature)
    setPending(null)
    setEdited(false)
    setCopied(false)
  }

  return (
    <section
      role="region"
      aria-label={t("artifacts.draftLabel")}
      data-testid="artifact-draft"
      className="max-h-[45%] shrink-0 overflow-y-auto border-t border-subtle bg-surface px-3 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{t("artifacts.draftLabel")}</h2>
        {pending ? (
          <button
            type="button"
            data-testid="artifact-draft-new"
            onClick={replace}
            className="btn btn-primary btn-xs"
          >
            {t("artifacts.draftNewResult")}
          </button>
        ) : null}
        <button
          type="button"
          data-testid="artifact-draft-copy"
          onClick={() => void copy()}
          className="btn btn-outline btn-xs"
        >
          {copied ? t("artifacts.draftCopied") : t("artifacts.draftCopy")}
        </button>
        <button
          type="button"
          data-testid="artifact-draft-dismiss"
          onClick={onDismiss}
          className="btn btn-ghost btn-xs"
        >
          {t("artifacts.draftDismiss")}
        </button>
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? t("artifacts.draftCopied") : ""}
      </span>

      <div className="mt-2 flex flex-col gap-2">
        <label
          htmlFor={`${baseId}-title`}
          className="flex flex-col gap-1 text-xs font-medium text-muted"
        >
          {t("artifacts.draftTitle")}
          <input
            id={`${baseId}-title`}
            data-testid="artifact-draft-title"
            value={draft.title}
            onChange={(event) => {
              setEdited(true)
              setDraft((current) => ({ ...current, title: event.target.value }))
            }}
            className="input input-sm w-full"
          />
        </label>

        <label
          htmlFor={`${baseId}-text`}
          className="flex flex-col gap-1 text-xs font-medium text-muted"
        >
          {t("artifacts.draftText")}
          <textarea
            id={`${baseId}-text`}
            data-testid="artifact-draft-text"
            rows={4}
            value={draft.text}
            onChange={(event) => {
              setEdited(true)
              setDraft((current) => ({ ...current, text: event.target.value }))
            }}
            className="textarea w-full font-mono text-sm"
          />
        </label>

        {draft.data === null ? null : (
          <div className="flex flex-col gap-1">
            <span id={`${baseId}-data`} className="text-xs font-medium text-muted">
              {t("artifacts.draftData")}
            </span>
            <p className="text-xs text-muted">{t("artifacts.draftDataNote")}</p>
            <pre
              aria-labelledby={`${baseId}-data`}
              data-testid="artifact-draft-data"
              className="overflow-x-auto rounded-row border border-subtle bg-code-bg px-3 py-2 font-mono text-xs"
            >
              {draft.data}
            </pre>
          </div>
        )}
      </div>
    </section>
  )
}
