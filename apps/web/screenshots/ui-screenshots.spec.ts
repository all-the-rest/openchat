// Generic manifest-driven screenshot spec for the ui-review skill.
//
// Reads the route/state/viewport matrix from `ui-review.config.ts` and captures
// viewport-height SECTION captures, plus a full-page PNG for short pages that
// scroll the window. Route specifics (seeds, nav steps, auth, scroller
// selectors) live in the manifest.
//
// Adapted for OpenChat: the login flow has one password field, and the
// authenticated app keeps an SSE connection open, so settling waits for DOM +
// key UI instead of `networkidle` (which would never be reached).
//
// All tests are tagged `@screenshot`; the set is separate from the functional
// E2E suite and never runs in CI's normal pipeline.

import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { routes, uiReviewConfig, uiReviewPassword } from "./ui-review.config"
import type {
  UiReviewNavStep,
  UiReviewRoute,
  UiReviewState,
  UiReviewViewport,
} from "./ui-review.config"

const SCREENSHOT_OUTPUT_DIR = uiReviewConfig.outputDir
const DEFAULT_LEADING_SECTIONS = 4
const DEFAULT_TRAILING_SECTIONS = 2
const FULL_PAGE_MAX_SECTIONS = 8

const out = (state: UiReviewState, viewport: UiReviewViewport, file: string) =>
  path.resolve(process.cwd(), SCREENSHOT_OUTPUT_DIR, state, viewport, file)

function viewportForPage(page: Page): { label: UiReviewViewport; width: number; height: number } {
  const size = page.viewportSize()
  if (!size) throw new Error("UI-review screenshot projects must use a fixed viewport")
  const matches = (Object.keys(uiReviewConfig.viewportSizes) as UiReviewViewport[]).filter(
    (label) => {
      const configured = uiReviewConfig.viewportSizes[label]
      return configured.width === size.width && configured.height === size.height
    },
  )
  if (matches.length !== 1) {
    throw new Error(
      `Actual viewport ${size.width}x${size.height} must match exactly one configured viewport label`,
    )
  }
  return { label: matches[0] as UiReviewViewport, ...size }
}

function resolvePath(pattern: string, params: Record<string, unknown>): string {
  return pattern.replace(/:([A-Za-z]+)/g, (_match, key: string) => {
    const value = params[key]
    if (value === undefined || value === null) {
      throw new Error(`Route param "${key}" was not resolved by the seed for "${pattern}"`)
    }
    return String(value)
  })
}

function resolveUrl(routePath: string, origin: string): string {
  return new URL(routePath, origin).toString()
}

/** Let the SPA + i18n settle so later clicks never race a layout shift. */
async function waitForAppSettled(page: Page): Promise<void> {
  // No `networkidle`: the authenticated app holds an SSE connection open.
  await page.waitForLoadState("domcontentloaded")
  await page.getByRole("main").waitFor({ state: "visible" })
  await page.waitForTimeout(300)
}

/** Temporarily disable CSS smooth scrolling while screenshots are positioned. */
async function withInstantScrollBehavior(page: Page, capture: () => Promise<void>): Promise<void> {
  const override = await page.addStyleTag({
    content: "html, body, * { scroll-behavior: auto !important; }",
  })
  try {
    await capture()
  } finally {
    await override.evaluate((style) => (style as Element).remove())
  }
}

/**
 * Captures readable viewport-height sections (80 % step, 20 % overlap), sampling
 * the top and footer on long pages. Detects an explicitly configured inner
 * container first, then a visible inner overflow container, and finally the
 * window.
 */
async function captureSections(
  page: Page,
  state: UiReviewState,
  viewport: UiReviewViewport,
  route: UiReviewRoute,
): Promise<void> {
  const scroller = await page.evaluate((configuredSelector) => {
    const doc = document.scrollingElement
    const winH = window.innerHeight
    const innerScroller = (element: HTMLElement, selector: string) => ({
      kind: "inner" as const,
      selector,
      viewportHeight: element.clientHeight,
      step: Math.max(1, Math.round(element.clientHeight * 0.8)),
    })
    const elementPath = (element: HTMLElement): string => {
      const segments: string[] = []
      let current: HTMLElement | null = element
      while (current && current !== document.body) {
        const tag = current.tagName.toLowerCase()
        const parent: HTMLElement | null = current.parentElement
        if (!parent) break
        const sameTagSiblings = Array.from(parent.children).filter(
          (sibling) => sibling.tagName === current!.tagName,
        )
        segments.unshift(`${tag}:nth-of-type(${sameTagSiblings.indexOf(current) + 1})`)
        current = parent
      }
      return `body > ${segments.join(" > ")}`
    }

    if (configuredSelector) {
      const element = document.querySelector<HTMLElement>(configuredSelector)
      if (!element) {
        throw new Error(`Scroll container selector "${configuredSelector}" matched no element`)
      }
      return innerScroller(element, configuredSelector)
    }

    const candidates = Array.from(document.querySelectorAll<HTMLElement>("body *"))
      .filter((element) => {
        if (
          element === doc ||
          element.clientHeight < 1 ||
          element.scrollHeight <= element.clientHeight + 4
        ) {
          return false
        }
        const style = getComputedStyle(element)
        if (
          !["auto", "scroll", "overlay"].includes(style.overflowY) ||
          style.display === "none" ||
          style.visibility === "hidden"
        ) {
          return false
        }
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < winH
      })
      .sort((a, b) => {
        const rectA = a.getBoundingClientRect()
        const rectB = b.getBoundingClientRect()
        const visibleAreaA =
          Math.max(0, Math.min(rectA.right, window.innerWidth) - Math.max(rectA.left, 0)) *
          Math.max(0, Math.min(rectA.bottom, winH) - Math.max(rectA.top, 0))
        const visibleAreaB =
          Math.max(0, Math.min(rectB.right, window.innerWidth) - Math.max(rectB.left, 0)) *
          Math.max(0, Math.min(rectB.bottom, winH) - Math.max(rectB.top, 0))
        return (
          visibleAreaB - visibleAreaA ||
          b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight)
        )
      })
    const candidate = candidates[0]
    if (candidate) {
      return innerScroller(candidate, elementPath(candidate))
    }
    return {
      kind: "window" as const,
      selector: null,
      viewportHeight: winH,
      step: Math.max(1, Math.round(winH * 0.8)),
    }
  }, route.scrollContainerSelector ?? uiReviewConfig.scrollContainerSelector)
  const scroll = (y: number) =>
    page.evaluate(
      ({ kind, selector, y: target }) => {
        if (kind === "inner") {
          if (!selector) throw new Error("The detected inner scroll container has no selector")
          const element = document.querySelector<HTMLElement>(selector)
          if (!element) {
            throw new Error(`Scroll container selector "${selector}" no longer matches an element`)
          }
          element.scrollTop = target
          return
        }
        if (document.scrollingElement) document.scrollingElement.scrollTop = target
      },
      { kind: scroller.kind, selector: scroller.selector, y },
    )
  const waitForScrollPaint = async () => {
    await page.waitForTimeout(150)
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  }
  const readScrollState = () =>
    page.evaluate(
      ({ kind, selector }) => {
        if (kind === "inner") {
          if (!selector) throw new Error("The detected inner scroll container has no selector")
          const element = document.querySelector<HTMLElement>(selector)
          if (!element) {
            throw new Error(`Scroll container selector "${selector}" no longer matches an element`)
          }
          return {
            max: Math.max(0, element.scrollHeight - element.clientHeight),
            scrollY: element.scrollTop,
          }
        }
        const doc = document.scrollingElement
        return {
          max: doc ? Math.max(0, doc.scrollHeight - window.innerHeight) : 0,
          scrollY: window.scrollY,
        }
      },
      { kind: scroller.kind, selector: scroller.selector },
    )
  const sectionOffsetsFor = (max: number) => {
    const offsets = [0]
    let last = 0
    while (last < max) {
      last = Math.min(max, last + scroller.step)
      offsets.push(last)
    }
    return offsets
  }

  const leadingSections = route.leadingSections ?? DEFAULT_LEADING_SECTIONS
  const trailingSections = route.trailingSections ?? DEFAULT_TRAILING_SECTIONS
  if (!Number.isInteger(leadingSections) || leadingSections < 1) {
    throw new Error(`Route "${route.name}" leadingSections must be a positive integer`)
  }
  if (!Number.isInteger(trailingSections) || trailingSections < 1) {
    throw new Error(`Route "${route.name}" trailingSections must be a positive integer`)
  }

  const scrollTolerance = 1
  const settleAtLiveEnd = async (): Promise<number> => {
    let max = (await readScrollState()).max
    let stableChecks = 0
    for (let check = 0; check < 20; check += 1) {
      await scroll(max)
      await route.waitForContentReady?.(page)
      await waitForScrollPaint()
      const live = await readScrollState()
      if (
        Math.abs(live.max - max) <= scrollTolerance &&
        Math.abs(live.scrollY - live.max) <= scrollTolerance
      ) {
        stableChecks += 1
      } else {
        stableChecks = 0
      }
      max = live.max
      if (stableChecks >= 2) return live.max
    }
    throw new Error(`Route "${route.name}" scroll range did not stabilize at its live end`)
  }

  let finalCapture:
    | {
        sectionOffsets: number[]
        capturedSectionIndexes: number[]
        capturedSections: Array<{ index: number; scrollY: number; image: Buffer }>
        fullPageOverview: boolean
        fullPageImage?: Buffer
        finalMax: number
      }
    | undefined

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const plannedMax = await settleAtLiveEnd()
    const sectionOffsets = sectionOffsetsFor(plannedMax)
    const captureAllSections = sectionOffsets.length <= FULL_PAGE_MAX_SECTIONS
    const fullPageOverview = captureAllSections && scroller.kind === "window"
    const leadingIndexes = Array.from(
      { length: Math.min(leadingSections, sectionOffsets.length) },
      (_value, index) => index,
    )
    const trailingCount = Math.min(trailingSections, sectionOffsets.length)
    const trailingIndexes = Array.from(
      { length: trailingCount },
      (_value, index) => sectionOffsets.length - trailingCount + index,
    )
    const capturedSectionIndexes = captureAllSections
      ? sectionOffsets.map((_offset, index) => index)
      : Array.from(new Set([...leadingIndexes, ...trailingIndexes])).sort((a, b) => a - b)

    const capturedSections: Array<{ index: number; scrollY: number; image: Buffer }> = []
    let rangeChanged = false
    for (const index of capturedSectionIndexes) {
      const targetY = sectionOffsets[index]!
      await scroll(targetY)
      await route.waitForContentReady?.(page)
      await waitForScrollPaint()
      const beforeCapture = await readScrollState()
      if (
        Math.abs(beforeCapture.max - plannedMax) > scrollTolerance ||
        Math.abs(beforeCapture.scrollY - targetY) > scrollTolerance
      ) {
        rangeChanged = true
        break
      }
      const image = await page.screenshot({ fullPage: false })
      const afterCapture = await readScrollState()
      if (
        Math.abs(afterCapture.max - plannedMax) > scrollTolerance ||
        Math.abs(afterCapture.scrollY - targetY) > scrollTolerance
      ) {
        rangeChanged = true
        break
      }
      capturedSections.push({ index, scrollY: beforeCapture.scrollY, image })
    }
    if (rangeChanged) continue

    const beforeFullPage = await readScrollState()
    const fullPageImage = fullPageOverview ? await page.screenshot({ fullPage: true }) : undefined
    const afterFullPage = await readScrollState()
    const lastCaptured = capturedSections[capturedSections.length - 1]
    if (
      Math.abs(afterFullPage.max - plannedMax) > scrollTolerance ||
      Math.abs(afterFullPage.scrollY - beforeFullPage.scrollY) > scrollTolerance ||
      (lastCaptured && Math.abs(beforeFullPage.scrollY - lastCaptured.scrollY) > scrollTolerance)
    ) {
      continue
    }
    const finalMax = await settleAtLiveEnd()
    const liveAtEnd = await readScrollState()
    const finalOffsets = sectionOffsetsFor(liveAtEnd.max)
    if (
      Math.abs(finalMax - plannedMax) > scrollTolerance ||
      Math.abs(liveAtEnd.max - plannedMax) > scrollTolerance ||
      Math.abs(liveAtEnd.scrollY - liveAtEnd.max) > scrollTolerance ||
      finalOffsets.length !== sectionOffsets.length
    ) {
      continue
    }

    finalCapture = {
      sectionOffsets: finalOffsets,
      capturedSectionIndexes,
      capturedSections,
      fullPageOverview,
      fullPageImage,
      finalMax: liveAtEnd.max,
    }
    break
  }

  if (!finalCapture) {
    throw new Error(`Route "${route.name}" scroll range kept changing while capturing`)
  }
  const capture = finalCapture

  const outputDirectory = path.dirname(out(state, viewport, `${route.name}.json`))
  await mkdir(outputDirectory, { recursive: true })
  if (capture.fullPageImage) {
    await writeFile(out(state, viewport, `${route.name}.png`), capture.fullPageImage)
  }
  for (const section of capture.capturedSections) {
    await writeFile(out(state, viewport, `${route.name}-sec${section.index}.png`), section.image)
  }

  const { width, height } = viewportForPage(page)
  const coverage = {
    route: route.name,
    state,
    viewport,
    viewportSize: { width, height },
    scrollContainer: {
      kind: scroller.kind,
      selector: scroller.selector,
      maxScrollY: capture.finalMax,
      viewportHeight: scroller.viewportHeight,
    },
    sections: capture.sectionOffsets.length,
    capturedSectionIndexes: capture.capturedSectionIndexes,
    capturedSections: capture.capturedSections.map(({ index, scrollY }) => ({ index, scrollY })),
    footerReady: Boolean(route.waitForContentReady),
    footerSectionIndex:
      route.waitForContentReady &&
      capture.capturedSections.some(
        (section) =>
          section.index === capture.sectionOffsets.length - 1 &&
          Math.abs(section.scrollY - capture.finalMax) <= scrollTolerance,
      )
        ? capture.sectionOffsets.length - 1
        : null,
    fullPageOverview: capture.fullPageOverview,
  }
  await writeFile(
    out(state, viewport, `${route.name}.json`),
    `${JSON.stringify(coverage, null, 2)}\n`,
    "utf8",
  )
  await scroll(0)
}

/** UI login through the real form: one password field, then a redirect to `/`. */
async function loginViaUi(page: Page, origin: string, landing: RegExp): Promise<void> {
  await page.goto(`${origin}/login`)
  await expect(page).toHaveURL(/\/login$/)
  const main = page.getByRole("main")
  await main.getByTestId("login-password").fill(uiReviewPassword)
  await main.getByTestId("login-submit").click()
  await expect(page).toHaveURL(landing)
  await waitForAppSettled(page)
}

async function applyNavStep(
  page: Page,
  step: UiReviewNavStep,
  seed: Record<string, unknown>,
  origin: string,
): Promise<void> {
  if (step.kind === "goto") {
    await page.goto(resolveUrl(resolvePath(step.path, seed), origin))
    return
  }

  const region = page.getByRole(step.scope)
  let locator = region.getByRole(
    step.role,
    step.name !== undefined ? { name: step.name, exact: true } : undefined,
  )
  if (step.within !== undefined) {
    locator = region
      .locator("article", { hasText: String(seed[step.within]) })
      .getByRole(step.role, { name: step.name, exact: true })
  }
  await locator.first().click()
  await waitForAppSettled(page)
}

async function settleAndCapture(
  page: Page,
  route: UiReviewRoute,
  state: UiReviewState,
  viewport: UiReviewViewport,
): Promise<void> {
  await waitForAppSettled(page)
  await expect(page).toHaveTitle(route.expectedTitle)
  await expect(page.getByRole("main")).toBeVisible()
  await withInstantScrollBehavior(page, () => captureSections(page, state, viewport, route))
}

for (const route of routes) {
  for (const state of route.states) {
    for (const viewport of route.viewports ?? ["desktop", "mobile"]) {
      test(
        `screenshot ${route.name} (${state}, ${viewport})`,
        { tag: ["@screenshot"] },
        async ({ page }) => {
          const actualViewport = viewportForPage(page)
          test.skip(
            actualViewport.label !== viewport,
            `actual viewport ${actualViewport.width}x${actualViewport.height} maps to ${actualViewport.label}, not ${viewport}`,
          )

          const origin = uiReviewConfig.primaryOrigin
          const seed = route.seeds?.[state] ? await route.seeds[state]() : {}

          await page.goto(`${origin}/`)
          await waitForAppSettled(page)

          if (route.auth === "user") {
            await loginViaUi(page, origin, /\/$/)
          }

          for (const step of route.nav ?? []) {
            await applyNavStep(page, step, seed, origin)
          }

          await settleAndCapture(page, route, state, viewport)
        },
      )
    }
  }
}
