// UI-review route manifest — the single source of truth for which pages get
// screenshotted and in which states. Edit this file to add/remove routes; the
// generic spec picks the changes up automatically.
//
// The app is single-tenant and single-user: every authenticated route logs in
// through the real login form with the development password. Data comes from
// the fake backend (`BACKEND_MODE=fake`), so seeds are deterministic and cost no
// provider quota.

import type { Page } from "@playwright/test"

export type UiReviewState = "filled" | "empty"
export type UiReviewViewport = "mobile" | "tablet" | "desktop" | "wide"
export type UiReviewAuth = "user" | "none"

export interface UiReviewViewportSize {
  width: number
  height: number
}

export interface UiReviewClickStep {
  kind: "click"
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

const ORIGIN = "http://localhost:5173"
const APP_TITLE = "OpenChat"
const ALL_VIEWPORTS: UiReviewViewport[] = ["mobile", "tablet", "desktop", "wide"]

async function loginCookie(): Promise<string> {
  const response = await fetch(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: uiReviewPassword }),
  })
  if (!response.ok) throw new Error(`ui-review seed login failed: ${response.status}`)
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .find((value) => value?.startsWith("oc_session="))
  if (!cookie) throw new Error("ui-review seed login set no oc_session cookie")
  return cookie
}

async function waitForAssistant(
  cookie: string,
  sessionID: string,
  terminal: "complete" | "error" = "complete",
): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const response = await fetch(`${ORIGIN}/api/sessions/${sessionID}/messages`, {
      headers: { cookie },
    })
    if (!response.ok) throw new Error(`ui-review seed message poll failed: ${response.status}`)
    const body = (await response.json()) as unknown
    const messages = Array.isArray(body) ? body : ((body as { messages?: unknown[] }).messages ?? [])
    const last = messages[messages.length - 1] as { role?: string; status?: string } | undefined
    if (last?.role === "assistant" && last.status === terminal) return
    if (last?.role === "assistant" && last.status === "stopped") {
      throw new Error("ui-review seed assistant was stopped")
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error("ui-review seed assistant did not finish within 30 s")
}

async function createSession(
  title: string,
  prompt?: string,
  terminal: "complete" | "error" = "complete",
): Promise<{ sessionId: string }> {
  const cookie = await loginCookie()
  const created = await fetch(`${ORIGIN}/api/sessions`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ title }),
  })
  if (!created.ok) throw new Error(`ui-review seed session failed: ${created.status}`)
  const { id } = (await created.json()) as { id: string }

  if (prompt) {
    const prompted = await fetch(`${ORIGIN}/api/sessions/${id}/prompt`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: prompt }),
    })
    if (!prompted.ok) throw new Error(`ui-review seed prompt failed: ${prompted.status}`)
    await waitForAssistant(cookie, id, terminal)
  }

  return { sessionId: id }
}

/**
 * One session per scenario for the whole run: every viewport shows the same
 * transcript and the sidebar does not grow by one entry per screenshot.
 */
const seeds = new Map<string, Promise<Record<string, unknown>>>()

function seedOnce(key: string, seed: () => Promise<Record<string, unknown>>) {
  return () => {
    const existing = seeds.get(key)
    if (existing) return existing
    const created = seed()
    seeds.set(key, created)
    return created
  }
}

const seedRichChat = seedOnce("rich", () => createSession("Rendering showcase", "rich: show the rendering"))
const seedToolsChat = seedOnce("tools", () => createSession("Tool cards", "tools: run the tools"))
const seedErrorChat = seedOnce("error", () => createSession("Failed run", "error: fail the run", "error"))
const seedEmptyChat = seedOnce("empty", () => createSession("Fresh chat"))

const chatTranscript: UiReviewNavStep[] = [
  {
    kind: "goto",
    path: "/c/:sessionId",
    reason: "Dynamic detail route created by the seed; the sidebar label is not stable enough to click.",
  },
]

const waitForMermaid = async (page: Page) => {
  await page.locator('[data-testid="mermaid"] svg').first().waitFor({ timeout: 30_000 })
}

const waitForToolCards = async (page: Page) => {
  await page.locator('[data-testid="tool-card"]').first().waitFor({ timeout: 30_000 })
}

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
    },
    {
      name: "landing",
      path: "/",
      expectedTitle: APP_TITLE,
      states: ["empty"],
      auth: "user",
      viewports: ALL_VIEWPORTS,
      note: "Transcript empty state. The sidebar lists the seeded chats created by earlier projects in the same run.",
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
      name: "chat-empty",
      path: "/c/:sessionId",
      expectedTitle: APP_TITLE,
      states: ["empty"],
      auth: "user",
      viewports: ["mobile", "desktop"],
      seeds: { empty: seedEmptyChat },
      nav: chatTranscript,
      scrollContainerSelector: '[data-testid="transcript"]',
    },
  ],
}

export const routes = uiReviewConfig.routes
