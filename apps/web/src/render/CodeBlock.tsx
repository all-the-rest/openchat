import { useEffect, useRef, useState, type ReactNode } from "react"
import { useT } from "../i18n/provider"
import { copyText } from "../lib/clipboard"
import { CheckIcon, CopyIcon, WrapIcon } from "../components/icons"

export interface CodeBlockProps {
  code: string
  language?: string
  /** Pre-highlighted code element from rehype-highlight, when available. */
  children?: ReactNode
}

export function CodeBlock({ code, language, children }: CodeBlockProps) {
  const t = useT()
  const [wrapped, setWrapped] = useState(false)
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    return () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current)
    }
  }, [])

  const copy = async () => {
    const ok = await copyText(code)
    if (!ok) return
    setCopied(true)
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 2000)
  }

  return (
    <figure className="my-3 overflow-hidden rounded-card border border-subtle bg-code-bg">
      <figcaption className="flex items-center gap-2 border-b border-subtle px-3 py-1.5 text-xs text-muted">
        <span className="min-w-0 flex-1 truncate font-mono">{language ?? t("render.code")}</span>
        <button
          type="button"
          onClick={() => setWrapped((current) => !current)}
          aria-pressed={wrapped}
          aria-label={t("render.wrap")}
          title={t("render.wrap")}
          className="btn btn-ghost btn-xs btn-square text-muted"
        >
          <WrapIcon className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={t("render.copyCode")}
          title={t("render.copyCode")}
          className="btn btn-ghost btn-xs btn-square text-muted"
        >
          {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
        </button>
        <span role="status" aria-live="polite" className="sr-only">
          {copied ? t("render.copied") : ""}
        </span>
      </figcaption>
      {children ? (
        <pre
          className={
            wrapped
              ? "overflow-x-auto whitespace-pre-wrap break-words p-3"
              : "overflow-x-auto p-3"
          }
        >
          {children}
        </pre>
      ) : (
        <pre
          className={
            wrapped
              ? "overflow-x-auto whitespace-pre-wrap break-words p-3"
              : "overflow-x-auto p-3"
          }
        >
          <code className="hljs block font-mono text-sm">{code}</code>
        </pre>
      )}
    </figure>
  )
}
