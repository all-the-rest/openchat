// One-time seed creation for the ui-review screenshot set.
//
// The `seed` project in `playwright.screenshots.config.ts` runs `seedAll()`
// once, before any viewport project starts, and writes the created session IDs
// to the JSON file at `UI_REVIEW_SEEDS`. That happens on every run that selects
// a viewport project, including `--project <name>`; only a `--grep` that drops
// the setup test skips it and reuses the previous run's file. The viewport
// projects then only read that file (see `ui-review.config.ts`), so the four
// scenarios and therefore the sidebar are identical in every capture, no
// matter how the viewport projects interleave.
//
// The sessions are created sequentially on purpose: the sidebar lists the
// chats in creation order, so the order here is part of the captured pixels.

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import {
  uiReviewPassword,
  uiReviewSeedFilePath,
  type UiReviewSeedFile,
  type UiReviewSeedRecord,
} from "./ui-review.config"

const ORIGIN = "http://localhost:5173"
const ASSISTANT_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 200

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
  const deadline = Date.now() + ASSISTANT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const response = await fetch(`${ORIGIN}/api/sessions/${sessionID}/messages`, {
      headers: { cookie },
    })
    if (!response.ok) {
      throw new Error(`ui-review seed message poll failed: ${response.status}`)
    }
    const body = (await response.json()) as unknown
    const messages = Array.isArray(body) ? body : ((body as { messages?: unknown[] }).messages ?? [])
    const last = messages[messages.length - 1] as { role?: string; status?: string } | undefined
    if (last?.role === "assistant" && last.status === terminal) return
    if (last?.role === "assistant" && last.status === "stopped") {
      throw new Error("ui-review seed assistant was stopped")
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error(
    `ui-review seed assistant did not reach "${terminal}" within ${ASSISTANT_TIMEOUT_MS / 1000} s`,
  )
}

async function createSession(
  cookie: string,
  title: string,
  prompt?: string,
  terminal: "complete" | "error" = "complete",
): Promise<UiReviewSeedRecord> {
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
 * Create the four ui-review scenarios and persist their session IDs.
 *
 * Idempotent per run only: every call adds four new sessions to the fake
 * backend, which is why exactly one test (in the `seed` project) calls it.
 */
export async function seedAll(): Promise<UiReviewSeedFile> {
  const file = uiReviewSeedFilePath()
  // Remove a previous run's file first: if seeding fails halfway, the viewport
  // projects must fail on a missing file instead of capturing dead session IDs
  // from the stale one.
  rmSync(file, { force: true })

  const cookie = await loginCookie()
  const rich = await createSession(cookie, "Rendering showcase", "rich: show the rendering")
  const tools = await createSession(cookie, "Tool cards", "tools: run the tools")
  const error = await createSession(cookie, "Failed run", "error: fail the run", "error")
  const empty = await createSession(cookie, "Fresh chat")
  const seeds: UiReviewSeedFile = { rich, tools, error, empty }

  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(seeds, null, 2)}\n`, "utf8")
  return seeds
}
