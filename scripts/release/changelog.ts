/**
 * Changelog generation: commits since the last release tag, grouped by the
 * issue they reference (`Refs #N` / `Closes #N`) and by conventional type.
 *
 * The output is deterministic: sections follow Keep a Changelog order, entries
 * follow issue order, unreferenced commits follow alphabetically, and the date
 * is either passed in or taken from UTC (`SOURCE_DATE_EPOCH` included), never
 * from the local timezone.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { CHANGELOG_FILE, CHANGELOG_HEADER, SECTION_BY_TYPE, SECTION_ORDER } from "./config.ts"
import type { Section } from "./config.ts"
import type { RawCommit } from "./git.ts"
import { UsageError } from "./git.ts"

export interface ChangelogEntry {
  issues: number[]
  breaking: boolean
  subjects: string[]
}

export type SectionEntries = Map<Section, ChangelogEntry[]>

interface ParsedSubject {
  type: string | null
  description: string
  breaking: boolean
}

const CONVENTIONAL_RE = /^([a-zA-Z]+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/
const REFS_RE = /\b(?:Refs|Closes|Fixes)\s+((?:#\d+[\s,]*)+)/gi
const ISSUE_RE = /#(\d+)/g
const BREAKING_RE = /\bBREAKING[ -]CHANGE:/i

export function parseSubject(subject: string): ParsedSubject {
  const match = CONVENTIONAL_RE.exec(subject)
  if (!match) return { type: null, description: subject, breaking: false }
  return {
    type: (match[1] ?? "").toLowerCase(),
    description: match[4] ?? subject,
    breaking: match[3] === "!",
  }
}

/** Issue numbers named by `Refs`/`Closes`/`Fixes`, sorted and deduplicated. */
export function extractIssues(text: string): number[] {
  const issues = new Set<number>()
  for (const match of text.matchAll(REFS_RE)) {
    for (const issue of (match[1] ?? "").matchAll(ISSUE_RE)) {
      const value = Number(issue[1])
      if (Number.isInteger(value)) issues.add(value)
    }
  }
  return [...issues].sort((left, right) => left - right)
}

function sectionOf(type: string | null): Section {
  if (type === null) return "Changed"
  return SECTION_BY_TYPE[type] ?? "Changed"
}

/** Group commits into sections; one entry per (issue, breaking) pair. */
export function groupCommits(commits: RawCommit[]): SectionEntries {
  const sections: SectionEntries = new Map()
  const keys = new Map<string, Map<string, ChangelogEntry>>()
  for (const commit of commits) {
    const parsed = parseSubject(commit.subject)
    const breaking = parsed.breaking || BREAKING_RE.test(commit.body)
    const issues = extractIssues(`${commit.subject}\n${commit.body}`)
    const section = sectionOf(parsed.type)
    const entries = sections.get(section) ?? []
    const sectionKeys = keys.get(section) ?? new Map<string, ChangelogEntry>()
    const first = issues[0]
    const key = `${first === undefined ? `commit:${commit.hash}` : `issue:${first}`}|${breaking}`
    let entry = sectionKeys.get(key)
    if (entry === undefined) {
      entry = { issues, breaking, subjects: [] }
      entries.push(entry)
      sectionKeys.set(key, entry)
    } else {
      entry.issues = [...new Set([...entry.issues, ...issues])].sort((left, right) => left - right)
    }
    if (!entry.subjects.includes(parsed.description)) entry.subjects.push(parsed.description)
    sections.set(section, entries)
    keys.set(section, sectionKeys)
  }
  for (const entries of sections.values()) {
    entries.sort((left, right) => {
      const leftIssue = left.issues[0]
      const rightIssue = right.issues[0]
      if (leftIssue !== undefined && rightIssue !== undefined) return leftIssue - rightIssue
      if (leftIssue !== undefined) return -1
      if (rightIssue !== undefined) return 1
      return (left.subjects[0] ?? "").localeCompare(right.subjects[0] ?? "")
    })
  }
  return sections
}

function renderEntry(entry: ChangelogEntry): string {
  const text = entry.subjects.join("; ")
  const refs = entry.issues.length === 0 ? "" : ` (${entry.issues.map((issue) => `#${issue}`).join(", ")})`
  return `- ${entry.breaking ? "**Breaking:** " : ""}${text}${refs}`
}

/** The `## [version] - date` block, or null when there is nothing to note. */
export function renderRelease(
  sections: SectionEntries,
  version: string,
  date: string,
): string | null {
  const blocks: string[] = []
  for (const section of SECTION_ORDER) {
    const entries = sections.get(section)
    if (!entries || entries.length === 0) continue
    blocks.push([`### ${section}`, "", ...entries.map(renderEntry)].join("\n"))
  }
  if (blocks.length === 0) return null
  return [`## [${version}] - ${date}`, "", blocks.join("\n\n")].join("\n")
}

export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const parsed = new Date(`${date}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
}

/**
 * The release date: `--date`, else `SOURCE_DATE_EPOCH`, else the committer date
 * of the newest commit. The last one is a fact of the history, so the same
 * history produces the same bytes on any machine; the runner's timezone never
 * enters the file.
 */
export function resolveDate(
  date: string | undefined,
  newestCommitterDate: string,
): string {
  if (date !== undefined) {
    if (!isValidDate(date)) throw new UsageError(`--date must be YYYY-MM-DD, got ${date}`)
    return date
  }
  const epoch = process.env.SOURCE_DATE_EPOCH
  if (epoch !== undefined && epoch.length > 0) {
    const seconds = Number(epoch)
    if (!Number.isInteger(seconds) || seconds < 0) {
      throw new UsageError("SOURCE_DATE_EPOCH must be a non-negative integer")
    }
    return new Date(seconds * 1000).toISOString().slice(0, 10)
  }
  if (!isValidDate(newestCommitterDate)) {
    throw new UsageError("cannot determine the release date; pass --date")
  }
  return newestCommitterDate
}

export function readChangelog(root: string): string {
  const path = join(root, CHANGELOG_FILE)
  return existsSync(path) ? readFileSync(path, "utf8") : CHANGELOG_HEADER
}

interface ChangelogParts {
  head: string
  sections: string[]
}

function splitChangelog(text: string): ChangelogParts {
  const lines = text.replace(/\s+$/, "").split("\n")
  const starts: number[] = []
  lines.forEach((line, index) => {
    if (/^## \[/.test(line)) starts.push(index)
  })
  if (starts.length === 0) return { head: lines.join("\n"), sections: [] }
  const first = starts[0] ?? lines.length
  const head = lines.slice(0, first).join("\n").trimEnd()
  const sections: string[] = []
  starts.forEach((start, index) => {
    const end = starts[index + 1] ?? lines.length
    sections.push(lines.slice(start, end).join("\n").trimEnd())
  })
  return { head, sections }
}

export function hasVersion(text: string, version: string): boolean {
  return text.split("\n").some((line) => line.startsWith(`## [${version}]`))
}

/** Insert the block at the top; an existing block for the version is replaced. */
export function insertRelease(text: string, version: string, block: string): string {
  const parts = splitChangelog(text)
  const kept = parts.sections.filter((section) => {
    const match = /^## \[([^\]]+)\]/.exec(section)
    return match?.[1] !== version
  })
  const head = parts.head.length > 0 ? parts.head : CHANGELOG_HEADER.trimEnd()
  return `${head}\n\n${[block, ...kept].join("\n\n")}\n`
}

export interface ChangelogResult {
  contents: string
  block: string
}

export function buildChangelog(
  root: string,
  commits: RawCommit[],
  version: string,
  date: string,
): ChangelogResult | null {
  const block = renderRelease(groupCommits(commits), version, date)
  if (block === null) return null
  return { contents: insertRelease(readChangelog(root), version, block), block }
}

export function requireVersion(version: string): string {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new UsageError(`not a version: ${version}`)
  }
  return version
}
