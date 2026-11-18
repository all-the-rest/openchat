import { readFileSync } from "node:fs"

/**
 * Fixture inputs for the tool slice, not compiled output. `calculator`,
 * `chart` and `broken` are the JSX the model writes; `cdn.html` is final HTML
 * on purpose (a document, not an app), so the remote-reference rule can be
 * checked against exactly the shape a hand-written artifact would have.
 *
 * The validator lives in `packages/artifact-tool` (slice 3). The oracle below
 * restates its documented remote-reference rule for the egress proof; it is a
 * test double, not a second validator.
 */
export type FixtureName = "calculator" | "chart" | "broken" | "cdn"

const FILES: Record<FixtureName, string> = {
  calculator: "./calculator.jsx",
  chart: "./chart.jsx",
  broken: "./broken.jsx",
  cdn: "./cdn.html",
}

export function readFixture(name: FixtureName): string {
  return readFileSync(new URL(FILES[name], import.meta.url), "utf8")
}

export const calculatorSource: string = readFixture("calculator")
export const chartSource: string = readFixture("chart")
export const brokenSource: string = readFixture("broken")
export const cdnSource: string = readFixture("cdn")

/** `http:`, `https:` and protocol-relative `//host` literals, as documented. */
const REMOTE_URL = /\bhttps?:\/\/[^\s"'`)<]+|(?:^|[\s"'(=])\/\/[a-z0-9][^\s"'`)<]*/gi

/** Every remote reference in a source or document, in source order. */
export function remoteReferences(source: string): string[] {
  const matches: string[] = []
  for (const match of source.matchAll(REMOTE_URL)) {
    matches.push(match[0].trim())
  }
  return matches
}

/** The documented rule: a remote URL literal fails the tool call. */
export function rejectsRemoteReference(source: string): boolean {
  return remoteReferences(source).length > 0
}

/** `<script src>` points at another origin (never allowed inside an artifact). */
export function externalScriptSources(html: string): string[] {
  const sources: string[] = []
  for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    const source = match[1] ?? ""
    if (/^(?:https?:)?\/\//i.test(source)) sources.push(source)
  }
  return sources
}
