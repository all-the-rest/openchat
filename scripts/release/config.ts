/**
 * Release layout: where the version lives and which files must agree.
 *
 * `VERSION` at the repository root is the single source of truth. Every
 * package that ships inside a deployed image mirrors it, and so does
 * `SERVER_VERSION`, which `/healthz` reports and `deploy/swap.sh` checks with
 * `--expect-version`.
 *
 * `apps/web` is deliberately absent: the web build is copied into the BFF
 * image, so it is versioned by the BFF and never published on its own.
 */
export const VERSION_FILE = "VERSION"
export const CHANGELOG_FILE = "CHANGELOG.md"
export const LOCKFILE_FILE = "pnpm-lock.yaml"
export const SERVER_VERSION_FILE = "apps/server/src/app.ts"

/** Workspace packages that are bundled into an image and must agree. */
export const UNVERSIONED_PACKAGES = ["apps/web"]

/** Keep a Changelog section order. */
export const SECTION_ORDER = [
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Security",
  "Documentation",
] as const

export type Section = (typeof SECTION_ORDER)[number]

/**
 * Conventional commit type to changelog section. Unknown types (including a
 * commit without a conventional prefix) land in `Changed` rather than
 * disappearing: a release note must not silently drop a change.
 */
export const SECTION_BY_TYPE: Record<string, Section> = {
  feat: "Added",
  fix: "Fixed",
  perf: "Changed",
  refactor: "Changed",
  build: "Changed",
  ci: "Changed",
  chore: "Changed",
  style: "Changed",
  test: "Changed",
  docs: "Documentation",
  security: "Security",
  deprecate: "Deprecated",
  remove: "Removed",
}

export const CHANGELOG_HEADER = `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
`
