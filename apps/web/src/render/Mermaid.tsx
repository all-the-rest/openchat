import { useEffect, useId, useRef, useState } from "react"
import { useT } from "../i18n/provider"
import { useTheme } from "../theme/provider"
import { CodeBlock } from "./CodeBlock"

/**
 * Mermaid is loaded lazily inside an effect so the transcript stays SSR- and
 * jsdom-safe. The SVG comes from mermaid itself; `securityLevel: "strict"`
 * sanitizes labels before it reaches the DOM.
 */
let configuredTheme: string | null = null

async function loadMermaid(theme: "dark" | "light") {
  const module = await import("mermaid")
  const mermaid = module.default
  if (configuredTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: theme === "dark" ? "dark" : "default",
      fontFamily: "inherit",
    })
    configuredTheme = theme
  }
  return mermaid
}

export function Mermaid({ chart }: { chart: string }) {
  const t = useT()
  const { theme } = useTheme()
  const reactID = useId().replace(/[^a-zA-Z0-9_-]/g, "")
  const renderCount = useRef(0)
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSvg(null)
    setFailed(false)

    const render = async () => {
      try {
        const mermaid = await loadMermaid(theme)
        renderCount.current += 1
        const id = `mermaid-${reactID}-${renderCount.current}`
        const result = await mermaid.render(id, chart)
        if (!cancelled) setSvg(result.svg)
      } catch {
        if (!cancelled) setFailed(true)
      }
    }

    void render()
    return () => {
      cancelled = true
    }
  }, [chart, reactID, theme])

  if (failed) {
    return (
      <div data-testid="mermaid-fallback" className="my-3">
        <CodeBlock code={chart} language="mermaid" />
      </div>
    )
  }

  if (!svg) {
    return (
      <div
        data-testid="mermaid"
        className="my-3 flex min-h-16 items-center justify-center rounded-card border border-subtle bg-surface p-4 text-sm text-muted"
      >
        <span className="loading loading-spinner loading-xs" aria-hidden="true" />
        <span className="ms-2">{t("render.mermaidLoading")}</span>
      </div>
    )
  }

  return (
    <div
      data-testid="mermaid"
      className="my-3 overflow-x-auto rounded-card border border-subtle bg-surface p-3"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
