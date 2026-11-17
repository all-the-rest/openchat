import type { ReactNode } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import rehypeHighlight from "rehype-highlight"
import rehypeKatex from "rehype-katex"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import { CodeBlock } from "./CodeBlock"
import { Mermaid } from "./Mermaid"

interface HastText {
  type: "text"
  value: string
}

interface HastElement {
  type: "element"
  tagName: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

type HastNode = HastText | HastElement

interface MarkdownProps {
  text: string
  className?: string
}

function findCodeElement(node: unknown): HastElement | undefined {
  if (node === null || typeof node !== "object") return undefined
  const element = node as HastElement
  if (element.type !== "element") return undefined
  if (element.tagName === "code") return element
  for (const child of element.children ?? []) {
    const found = findCodeElement(child)
    if (found) return found
  }
  return undefined
}

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value
  return (node.children ?? []).map(textOf).join("")
}

function languageOf(element: HastElement): string | undefined {
  const className = element.properties?.className
  const entries = Array.isArray(className)
    ? className.map((entry) => String(entry))
    : typeof className === "string"
      ? [className]
      : []
  for (const entry of entries) {
    const match = /^language-([\w-]+)$/.exec(entry)
    if (match && match[1]) return match[1]
  }
  return undefined
}

/**
 * Only absolute http(s)/mailto links, images with an image data URL and
 * same-document/root-relative links survive. `javascript:` and other
 * `data:` schemes are dropped.
 */
function safeUrl(url: string): string {
  const trimmed = url.trim()
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed
  if (/^data:image\//i.test(trimmed)) return trimmed
  if (trimmed.startsWith("#") || trimmed.startsWith("/")) return trimmed
  return ""
}

interface RendererProps {
  node?: unknown
  children?: ReactNode
  href?: string
  src?: string
  alt?: string
  className?: string
}

function PreBlock({ node, children }: RendererProps) {
  const code = findCodeElement(node)
  const source = code ? textOf(code) : ""
  const language = code ? languageOf(code) : undefined

  if (language === "mermaid") return <Mermaid chart={source} />

  return (
    <CodeBlock code={source} language={language}>
      {children}
    </CodeBlock>
  )
}

function CodeElement({ children, className }: RendererProps) {
  return <code className={className}>{children}</code>
}

function Anchor({ href, children }: RendererProps) {
  if (!href) return <span>{children}</span>
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}

function Image({ src, alt }: RendererProps) {
  const source = typeof src === "string" ? src : ""
  const label = typeof alt === "string" ? alt : ""

  // Remote images are never fetched; they downgrade to a link with the alt text.
  if (/^data:image\//i.test(source)) {
    return <img src={source} alt={label} loading="lazy" />
  }
  if (!source) return <span>{label}</span>
  return (
    <a href={source} target="_blank" rel="noopener noreferrer">
      {label || source}
    </a>
  )
}

const components: Components = {
  pre: PreBlock,
  code: CodeElement,
  a: Anchor,
  img: Image,
}

export function Markdown({ text, className = "" }: MarkdownProps) {
  return (
    <div className={`markdown min-w-0 ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, [rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={components}
        urlTransform={safeUrl}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
