// UI-review route manifest — the single source of truth for which pages get
// screenshotted and in which states. Edit this file to add/remove routes; the
// generic spec picks the changes up automatically.
//
// The app is single-tenant and single-user: every authenticated route logs in
// through the real login form with the development password. Data comes from
// the fake backend (`BACKEND_MODE=fake`), so seeds are deterministic and cost no
// provider quota.
//
// Sessions are NOT created here. The `seed` Playwright project
// (`screenshots/seed.setup.ts`) creates the four scenarios once per run and
// writes their IDs to `UI_REVIEW_SEEDS`; this manifest only reads that file.
// One seed set for the whole run is what keeps the sidebar identical in every
// capture while the four viewport projects run in parallel.

import { type Page } from "@playwright/test"
import { readFileSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import process from "node:process"
import {
  waitForAppsInventory,
  waitForCodeStub,
  waitForMermaid,
  waitForSearchResults,
  waitForToolCards,
} from "./waits"

export type UiReviewState = "filled" | "empty"
export type UiReviewViewport = "mobile" | "tablet" | "desktop" | "wide"
export type UiReviewAuth = "user" | "none"

/**
 * Extra state a capture can add on top of `state` + `viewport`.
 *
 * `theme` and `locale` are written to `localStorage` through `addInitScript`
 * before the app mounts (`THEME_STORAGE_KEY` / `LOCALE_STORAGE_KEY`), so the
 * first paint already uses them. `action` runs against the loaded page.
 */
export type UiReviewTheme = "dark" | "light"
export type UiReviewLocale = "en" | "de"
export type UiReviewVariantAction = "open-drawer" | "expand-tool" | "start-dictation"

export interface UiReviewVariant {
  name: string
  theme?: UiReviewTheme
  locale?: UiReviewLocale
  action?: UiReviewVariantAction
  /** Viewports that get this variant; defaults to every route viewport. */
  viewports?: UiReviewViewport[]
}

export interface UiReviewViewportSize {
  width: number
  height: number
}

export interface UiReviewClickStep {
  kind: "click"
  /** Landmarks; the chat app bar and the Code bar are both `banner`. */
  scope: "banner" | "complementary" | "main"
  role: "link" | "button"
  name?: string
  within?: string
}

export interface UiReviewGotoStep {
  kind: "goto"
  path: string
  reason: string
}

export type UiReviewNavStep = UiReviewClickStep | UiReviewGotoStep

export type UiReviewSeed = () => Promise<Record<string, unknown>>

/** Scenario keys of the seed file, in the order `seedAll()` creates them. */
export const uiReviewSeedKeys = ["rich", "tools", "error", "empty"] as const

export type UiReviewSeedKey = (typeof uiReviewSeedKeys)[number]

export interface UiReviewSeedRecord {
  sessionId: string
}

export type UiReviewSeedFile = Record<UiReviewSeedKey, UiReviewSeedRecord>

export interface UiReviewRoute {
  name: string
  path: string
  states: UiReviewState[]
  auth?: UiReviewAuth
  viewports?: UiReviewViewport[]
  note?: string
  expectedTitle: string
  seeds?: Partial<Record<UiReviewState, UiReviewSeed>>
  leadingSections?: number
  trailingSections?: number
  scrollContainerSelector?: string
  waitForContentReady?: (page: Page) => Promise<void>
  nav?: UiReviewNavStep[]
  variants?: UiReviewVariant[]
}

export interface UiReviewConfig {
  outputDir: string
  primaryOrigin: string
  viewportSizes: Record<UiReviewViewport, UiReviewViewportSize>
  scrollContainerSelector?: string
  routes: UiReviewRoute[]
}

/** Development password from `playwright.screenshots.config.ts`. */
export const uiReviewPassword = "test-password"

/** Environment variable that points setup project and workers at the seed file. */
export const uiReviewSeedFileEnv = "UI_REVIEW_SEEDS"
export const uiReviewSeedFileDefault = "test-results/ui-review-seeds.json"

/**
 * Absolute path of the seed file. `playwright.screenshots.config.ts` always
 * sets the variable to an absolute path, so every process resolves the same
 * file; the relative default only applies to a manual invocation.
 */
export function uiReviewSeedFilePath(): string {
  const configured = process.env[uiReviewSeedFileEnv] ?? uiReviewSeedFileDefault
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured)
}

const ORIGIN = "http://localhost:5173"
const APP_TITLE = "OpenChat"
const ALL_VIEWPORTS: UiReviewViewport[] = ["mobile", "tablet", "desktop", "wide"]

let seedFileCache: UiReviewSeedFile | undefined

/**
 * Read the seed file written by the `seed` project (`screenshots/seeds.ts`).
 *
 * Memoised per process: the setup project finishes before any viewport project
 * starts, so each worker reads the file once and every test in the run sees the
 * same four sessions. A missing seed file is a hard error rather than a silent
 * re-create, which would add duplicate sessions to the captured sidebar. The
 * `seed` project runs whenever a viewport project is selected (`--project
 * <name>` included), but a `--grep` that drops the setup test can reuse the
 * previous run's file, so run the whole set.
 */
function loadSeeds(): UiReviewSeedFile {
  if (seedFileCache) return seedFileCache
  const file = uiReviewSeedFilePath()
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch (cause) {
    throw new Error(
      `ui-review seeds are missing at ${file}. The "seed" project ` +
        `(screenshots/seed.setup.ts) writes them once before the viewport projects run, so ` +
        `run the whole set with \`pnpm --filter @openchat/web run test:screenshots\` rather ` +
        `than selecting a single viewport project.`,
      { cause },
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (cause) {
    throw new Error(`ui-review seeds at ${file} are not valid JSON`, { cause })
  }
  const record = (parsed ?? {}) as Partial<Record<UiReviewSeedKey, Partial<UiReviewSeedRecord>>>
  const seeds = {} as UiReviewSeedFile
  for (const key of uiReviewSeedKeys) {
    const sessionId = record[key]?.sessionId
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error(
        `ui-review seeds at ${file} have no session id for "${key}"; the file is stale or ` +
          `incomplete. Delete it and re-run the screenshot set so the "seed" project ` +
          `recreates it.`,
      )
    }
    seeds[key] = { sessionId }
  }
  seedFileCache = seeds
  return seeds
}

function seededSession(key: UiReviewSeedKey): UiReviewSeed {
  return async () => ({ sessionId: loadSeeds()[key].sessionId })
}

const seedRichChat = seededSession("rich")
const seedToolsChat = seededSession("tools")
const seedErrorChat = seededSession("error")
const seedEmptyChat = seededSession("empty")

const chatTranscript: UiReviewNavStep[] = [
  {
    kind: "goto",
    path: "/c/:sessionId",
    reason: "Dynamic detail route created by the seed; the sidebar label is not stable enough to click.",
  },
]

const searchQuery = "/search?scope=all&q=opencode"
const searchNoHits = "/search?scope=all&q=nothing"

/**
 * Variants only where they change what a reviewer can judge. The base captures
 * stay light (Playwright's default `prefers-color-scheme: light`), so `dark` has
 * signal; theme and locale are captured at the two layout extremes rather than
 * all four widths, because tablet (820) and wide (1920) reuse the desktop
 * column and only differ in surrounding space.
 */
const DARK: UiReviewVariant = { name: "dark", theme: "dark", viewports: ["mobile", "desktop"] }
const GERMAN: UiReviewVariant = { name: "de", locale: "de", viewports: ["mobile", "desktop"] }

export const uiReviewConfig: UiReviewConfig = {
  outputDir: "ui-review",
  primaryOrigin: ORIGIN,
  // Must match the screenshot projects in playwright.screenshots.config.ts.
  viewportSizes: {
    mobile: { width: 390, height: 844 },
    tablet: { width: 820, height: 1180 },
    desktop: { width: 1440, height: 900 },
    wide: { width: 1920, height: 1080 },
  },
  routes: [
    {
      name: "login",
      path: "/login",
      expectedTitle: APP_TITLE,
      states: ["empty"],
      auth: "none",
      viewports: ALL_VIEWPORTS,
      nav: [
        {
          kind: "goto",
          path: "/login",
          reason: "Route guard: unauthenticated visitors land here, so the form is reviewed directly.",
        },
      ],
      variants: [DARK, GERMAN],
    },
    {
      name: "landing",
      path: "/",
      expectedTitle: APP_TITLE,
      states: ["empty"],
      auth: "user",
      viewports: ALL_VIEWPORTS,
      note: "Transcript empty state. The sidebar lists the four sessions the seed project created for this run, in creation order.",
      variants: [
        DARK,
        GERMAN,
        // The drawer only exists below the wide breakpoint.
        { name: "drawer", action: "open-drawer", viewports: ["mobile", "tablet"] },
      ],
    },
    {
      name: "chat-rich",
      path: "/c/:sessionId",
      expectedTitle: APP_TITLE,
      states: ["filled"],
      auth: "user",
      viewports: ALL_VIEWPORTS,
      seeds: { filled: seedRichChat },
      nav: chatTranscript,
      scrollContainerSelector: '[data-testid="transcript"]',
      waitForContentReady: waitForMermaid,
      variants: [DARK, GERMAN],
    },
    {
      name: "chat-tools",
      path: "/c/:sessionId",
      expectedTitle: APP_TITLE,
      states: ["filled"],
      auth: "user",
      viewports: ["mobile", "desktop"],
      seeds: { filled: seedToolsChat },
      nav: chatTranscript,
      scrollContainerSelector: '[data-testid="transcript"]',
      waitForContentReady: waitForToolCards,
      variants: [DARK, { name: "expanded", action: "expand-tool" }],
    },
    {
      name: "chat-error",
      path: "/c/:sessionId",
      expectedTitle: APP_TITLE,
      states: ["filled"],
      auth: "user",
      viewports: ["mobile", "desktop"],
      seeds: { filled: seedErrorChat },
      nav: chatTranscript,
      scrollContainerSelector: '[data-testid="transcript"]',
    },
    {
      name: "search",
      path: searchQuery,
      expectedTitle: APP_TITLE,
      states: ["filled"],
      auth: "user",
      viewports: ALL_VIEWPORTS,
      note: "Grouped multi-source search over the fake fixtures: workspace and web hits for 'opencode', web citations with provider and hostname, the source toggles including a disabled one.",
      nav: [
        {
          kind: "goto",
          path: searchQuery,
          reason: "The query lives in the URL, so the page loads straight into a result set.",
        },
      ],
      waitForContentReady: waitForSearchResults,
      variants: [DARK, GERMAN],
    },
    {
      name: "search-empty",
      path: searchNoHits,
      expectedTitle: APP_TITLE,
      states: ["empty"],
      auth: "user",
      viewports: ["mobile", "desktop"],
      note: "A query with no matches: the empty-result announcement instead of an empty page.",
      nav: [
        {
          kind: "goto",
          path: searchNoHits,
          reason: "Empty state is a real query, not a blank field.",
        },
      ],
      variants: [DARK],
    },
    {
      name: "apps",
      path: "/apps",
      expectedTitle: APP_TITLE,
      states: ["filled"],
      auth: "user",
      viewports: ALL_VIEWPORTS,
      note: "The fake host's inventory: five MCP servers across the five statuses (connected, needs auth, failed, disabled, pending) with their bounded error text, and the two skills, one with the Auto badge. No real MCP server is contacted.",
      nav: [
        {
          kind: "goto",
          path: "/apps",
          reason: "The app bar has no entry and below 1024 px the sidebar's entry stays unmounted until the drawer opens; the route is the same one `nav-apps` links to, and the click path is covered by e2e/apps.spec.ts.",
        },
      ],
      waitForContentReady: waitForAppsInventory,
    },
    {
      name: "code-stub",
      path: "/code",
      expectedTitle: APP_TITLE,
      states: ["filled"],
      auth: "user",
      viewports: ALL_VIEWPORTS,
      note: "The frame is the stub Code host from apps/web/e2e/code-stub.ts, not the OpenCode UI: the capture shows the app's slim bar, the translated frame title and the stub page. Below 1024 px the app shows the desktop-orientation notice instead of the frame, by design.",
      nav: [
        {
          kind: "click",
          scope: "banner",
          role: "button",
          name: "Code",
        },
      ],
      waitForContentReady: waitForCodeStub,
    },
    {
      name: "chat-empty",
      path: "/c/:sessionId",
      expectedTitle: APP_TITLE,
      states: ["empty"],
      auth: "user",
      viewports: ["mobile", "desktop"],
      seeds: { empty: seedEmptyChat },
      nav: chatTranscript,
      scrollContainerSelector: '[data-testid="transcript"]',
      // The microphone and the recording pill only render when the BFF
      // advertises a configured STT service, which the screenshots config sets.
      variants: [{ name: "recording", action: "start-dictation" }],
    },
  ],
}

export const routes = uiReviewConfig.routes
