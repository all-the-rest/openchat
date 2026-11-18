/**
 * The artifact document shell from
 * [`07-artifact-runtime.md`](../../../docs/architecture/07-artifact-runtime.md).
 * It injects the runtime, so the stored document is portable on its own: the
 * download and the preview are the same bytes. No network, no `eval`.
 */

/** Bumped when the shell itself changes; asserted by a test. */
export const SHELL_VERSION = "1"

/**
 * Reset and the design tokens an app may use. The artifact has no access to
 * the app stylesheet; these five variables are its whole theme contract.
 */
export const SHELL_CSS = `:root{--bg:#ffffff;--fg:#14161a;--muted:#5b6472;--accent:#2563eb;--radius:10px;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#14161a;--fg:#f2f4f8;--muted:#a3adbb;--accent:#7aa2ff}}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
button,input,select,textarea{font:inherit;color:inherit}
#root{display:flow-root}`

/**
 * Placeholder for the `window.openchat` bridge. Slice 4 owns the bridge
 * (`artifact:init`, nonce, `setHeight`, `result`); until then this returns an
 * empty string and the shell adds no bridge script at all. A test asserts the
 * absence, so slice 4 cannot land the bridge by accident.
 */
export function bridgeScript(): string {
  return ""
}

export interface ShellInput {
  /** Already validated and trimmed; escaped here. */
  title: string
  /** Validated user CSS; may be empty. */
  css: string
  /** Minified IIFE from `compileModule`. */
  script: string
  /** Toolchain versions for the drift comment; injected by the caller/tests. */
  tools: { esbuild: string; preact: string }
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character)
}

/**
 * Deterministic for identical input: no timestamps, no random ids. The drift
 * comment carries the toolchain versions that produced the bundle.
 */
export function buildDocument(input: ShellInput): string {
  const bridge = bridgeScript()
  const bridgeTag = bridge.length > 0 ? `<script>${bridge}</script>\n` : ""
  return `<!doctype html><html lang="en" data-oc="${SHELL_VERSION}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(input.title)}</title>
<!-- openchat artifact shell ${SHELL_VERSION}; esbuild ${input.tools.esbuild}; preact ${input.tools.preact} -->
<style>${SHELL_CSS}</style>
<style>${input.css}</style>
</head><body><div id="root"></div>
${bridgeTag}<script>${input.script}</script>
</body></html>
`
}
