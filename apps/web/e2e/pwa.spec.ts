import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test, type Page } from "@playwright/test"
import { guardExternalRequests, login, startChat } from "./helpers"
import { PWA_ORIGIN } from "./pwa-fixture"

/**
 * The PWA needs a production build: Vite's dev server has no service worker.
 * This spec therefore uses its own BFF with `WEB_DIST_DIR` pointing at
 * `apps/web/dist` (built by the webServer command). Serial because the version
 * test edits that shared `sw.js` on disk.
 */
test.describe.configure({ mode: "serial" })
test.use({ baseURL: PWA_ORIGIN })

const WEB_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const SW_PATH = join(WEB_DIR, "dist", "sw.js")

async function waitForControlledShell(page: Page): Promise<void> {
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(1)
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
    if (navigator.serviceWorker.controller) return
    await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true })
    })
  })
  // `ready` resolves only after install finished, so the precache exists now.
  const cached = await page.evaluate(async () => (await caches.keys()).length > 0)
  expect(cached).toBe(true)
}

test("installability metadata is served same-origin with the right types", async ({ page }) => {
  const external = guardExternalRequests(page)
  await page.goto("/")

  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest",
  )
  const manifestResponse = await page.request.get(`${PWA_ORIGIN}/manifest.webmanifest`)
  expect(manifestResponse.ok()).toBe(true)
  expect(manifestResponse.headers()["content-type"]).toContain("application/manifest+json")
  const manifest = (await manifestResponse.json()) as {
    name: string
    display: string
    theme_color: string
    icons: Array<{ purpose?: string }>
  }
  expect(manifest.name).toBe("OpenChat")
  expect(manifest.display).toBe("standalone")
  expect(manifest.theme_color).toBe("#0f1115")
  expect(manifest.icons.some((icon: { purpose?: string }) => icon.purpose === "maskable")).toBe(true)

  const icon = await page.request.get(`${PWA_ORIGIN}/icons/icon-192.png`)
  expect(icon.ok()).toBe(true)
  expect(icon.headers()["content-type"]).toBe("image/png")
  const sw = await page.request.get(`${PWA_ORIGIN}/sw.js`)
  expect(sw.ok()).toBe(true)
  expect(sw.headers()["content-type"]).toContain("text/javascript")
  expect(external).toEqual([])
})

test("offline reload keeps the shell and explains the disabled composer", async ({ page, context }) => {
  const external = guardExternalRequests(page)
  await page.goto("/")
  await login(page)
  await startChat(page)
  await waitForControlledShell(page)

  await context.setOffline(true)
  try {
    await page.reload()
    await expect(page.getByTestId("app-bar")).toBeVisible()
    const banner = page.getByTestId("offline-banner")
    await expect(banner).toBeVisible()
    await expect(banner).toContainText("You are offline")
    await expect(page.getByTestId("composer")).toBeDisabled()
    await expect(page.getByText("Sending is unavailable while offline. Reconnect to start a new prompt."))
      .toBeVisible()
  } finally {
    await context.setOffline(false)
  }
  expect(external).toEqual([])
})

test("a new deployment shows the notice without reloading by itself", async ({ page }) => {
  const external = guardExternalRequests(page)
  await page.goto("/")
  await login(page)
  await waitForControlledShell(page)

  const original = readFileSync(SW_PATH, "utf8")
  const bumped = original.replace(/const VERSION = "[^"]+"/, 'const VERSION = "test-bump"')
  expect(bumped).not.toBe(original)
  await page.evaluate(() => {
    Object.defineProperty(window as Window & { __pwaNoSilentReload?: boolean }, "__pwaNoSilentReload", {
      value: true,
      configurable: true,
    })
  })

  try {
    writeFileSync(SW_PATH, bumped)
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration()
      await registration?.update()
    })
    const notice = page.getByTestId("update-notice")
    await expect(notice).toBeVisible()
    await expect(notice).toContainText("A new version is available")
    await expect(page.getByTestId("update-reload")).toBeEnabled()

    // The marker and the URL survive: the notice never reloaded the page.
    expect(
      await page.evaluate(
        () => (window as Window & { __pwaNoSilentReload?: boolean }).__pwaNoSilentReload,
      ),
    ).toBe(true)
    expect(new URL(page.url()).pathname).toBe("/")
  } finally {
    writeFileSync(SW_PATH, original)
  }
  expect(external).toEqual([])
})
