import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { build, transform } from "esbuild"
import type { BuildFailure, BuildResult } from "esbuild"

/**
 * The compile step. The architecture names `Bun.build`; the repository is
 * Node/pnpm, so the same job runs on esbuild. The deviation and its reason are
 * recorded in `docs/implementation/09-artifacts.md`.
 */

/** Package root: `preact` and `preact/hooks` resolve from the tool's own tree. */
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url))
const require = createRequire(import.meta.url)

function installedVersion(specifier: string): string {
  const manifest = require(`${specifier}/package.json`) as { version?: unknown }
  return typeof manifest.version === "string" ? manifest.version : "unknown"
}

export const ESBUILD_VERSION = installedVersion("esbuild")
export const PREACT_VERSION = installedVersion("preact")

/**
 * Injected runtime and mount, appended after the app module. Imports are legal
 * after statements (they hoist), so the user's line numbers stay 1..n: an
 * error at `code:3:14` points at line 3 of what the model wrote.
 */
export const RUNTIME_TAIL = `
import { h, render, Fragment } from "preact"
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "preact/hooks"
const __openchatRoot = document.getElementById("root")
if (!__openchatRoot) throw new Error("artifact shell is missing #root")
render(h(App), __openchatRoot)
`

export interface CompileSuccess {
  /** Minified IIFE: Preact plus the app, no imports left. */
  script: string
  /** Non-blocking compiler messages, already formatted. */
  warnings: string[]
}

export type CompileResult = CompileSuccess | { error: string }

function formatLocation(
  location: { file?: string; line?: number; column?: number; lineText?: string } | null | undefined,
  text: string,
): string {
  const line = location?.line ?? 1
  const column = (location?.column ?? 0) + 1
  // esbuild includes its own `file:line:column` in `text` for file inputs; we
  // format it once, from the location, so the shape stays `code:line:column`.
  const detail = text.replace(/^\S+\.jsx?:\d+:\d+:\s*/, "")
  return `code:${line}:${column}: ${detail}`
}

function isBuildFailure(value: unknown): value is BuildFailure {
  return typeof value === "object" && value !== null && "errors" in value
}

function diagnostic(error: unknown): string | null {
  if (!isBuildFailure(error)) return null
  const first = error.errors[0]
  if (!first) return null
  return formatLocation(first.location, first.text)
}

/** Shared JSX options, so the syntax pass and the bundle parse identically. */
const JSX_OPTIONS = {
  loader: "jsx",
  jsx: "transform",
  jsxFactory: "h",
  jsxFragment: "Fragment",
  sourcefile: "app.jsx",
  logLevel: "silent",
} as const

/**
 * Syntax first, on the module alone: an unclosed JSX tag otherwise swallows the
 * appended runtime and the error points at a line the model never wrote.
 */
async function checkSyntax(code: string): Promise<string | null> {
  try {
    await transform(code, JSX_OPTIONS)
    return null
  } catch (error: unknown) {
    return diagnostic(error) ?? "compiler: the module failed without a diagnostic"
  }
}

/**
 * Bundles the module into one self-contained script. `write: false` keeps the
 * output in memory; nothing touches the workspace.
 */
export async function compileModule(code: string): Promise<CompileResult> {
  const syntaxError = await checkSyntax(code)
  if (syntaxError) return { error: syntaxError }

  let result: BuildResult
  try {
    result = await build({
      stdin: {
        contents: `${code}\n${RUNTIME_TAIL}`,
        loader: "jsx",
        resolveDir: PACKAGE_ROOT,
        sourcefile: "app.jsx",
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      target: "es2020",
      charset: "utf8",
      legalComments: "none",
      jsx: "transform",
      jsxFactory: "h",
      jsxFragment: "Fragment",
      logLevel: "silent",
    })
  } catch (error: unknown) {
    return { error: diagnostic(error) ?? "compiler: the bundle failed without a diagnostic" }
  }

  const output = result.outputFiles?.[0]?.text
  if (!output) return { error: "compiler: no output was produced" }
  if (/<\/script/i.test(output)) {
    // The validator rejects this in the source; the check covers a string that
    // is assembled at compile time (for example from parts) and would end the
    // inline script element.
    return { error: "shell-injection: the compiled script contains </script" }
  }

  return {
    script: output,
    warnings: result.warnings.map((warning) => formatLocation(warning.location, warning.text)),
  }
}
