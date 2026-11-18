// Capture machinery for the ui-review screenshot set.
//
// Captures readable viewport-height sections (80 % step, 20 % overlap),
// sampling the top and footer on long pages, plus a full-page PNG when a short
// page scrolls the window. Writes the PNGs and the per-capture JSON metadata
// into `ui-review/<state>/<viewport>/`.

import type { Page } from "@playwright/test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { detectScroller } from "./scroller"
import { uiReviewConfig } from "./ui-review.config"
import type { UiReviewRoute, UiReviewState, UiReviewVariant, UiReviewViewport } from "./ui-review.config"

const SCREENSHOT_OUTPUT_DIR = uiReviewConfig.outputDir
const DEFAULT_LEADING_SECTIONS = 4
const DEFAULT_TRAILING_SECTIONS = 2
const FULL_PAGE_MAX_SECTIONS = 8

/** File stem: `route` for the base capture, `route-variant` for a variant. */
export function captureName(route: UiReviewRoute, variant?: UiReviewVariant): string {
  return variant ? `${route.name}-${variant.name}` : route.name
}

export function out(state: UiReviewState, viewport: UiReviewViewport, file: string): string {
  return path.resolve(process.cwd(), SCREENSHOT_OUTPUT_DIR, state, viewport, file)
}

export function viewportForPage(page: Page): {
  label: UiReviewViewport
  width: number
  height: number
} {
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

/** Theme as actually applied, read back from the document instead of assumed. */
async function appliedSettings(page: Page): Promise<{ theme: string | null; locale: string | null }> {
  const { theme, locale } = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme ?? null,
    locale: document.documentElement.lang || null,
  }))
  return {
    theme: theme === "openchat" ? "dark" : theme === "openchat-light" ? "light" : null,
    locale,
  }
}

export async function captureSections(
  page: Page,
  state: UiReviewState,
  viewport: UiReviewViewport,
  route: UiReviewRoute,
  variant?: UiReviewVariant,
): Promise<void> {
  // Routes are lazy chunks (#26), so the shell's <main> is visible before the
  // page has mounted its own scroller. Waiting for a content marker the route
  // names, and for the scroller itself, keeps the detection off the shell.
  await route.waitForContentReady?.(page)
  const scroller = await detectScroller(
    page,
    route.scrollContainerSelector ?? uiReviewConfig.scrollContainerSelector,
  )
  const scroll = scroller.scrollTo
  const waitForScrollPaint = async () => {
    await page.waitForTimeout(150)
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  }
  const readScrollState = scroller.read
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

  const stem = captureName(route, variant)
  const outputDirectory = path.dirname(out(state, viewport, `${stem}.json`))
  await mkdir(outputDirectory, { recursive: true })
  if (capture.fullPageImage) {
    await writeFile(out(state, viewport, `${stem}.png`), capture.fullPageImage)
  }
  for (const section of capture.capturedSections) {
    await writeFile(out(state, viewport, `${stem}-sec${section.index}.png`), section.image)
  }

  const { width, height } = viewportForPage(page)
  const measured = await appliedSettings(page)
  const coverage = {
    route: route.name,
    variant: variant?.name ?? null,
    theme: measured.theme,
    locale: measured.locale,
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
    out(state, viewport, `${stem}.json`),
    `${JSON.stringify(coverage, null, 2)}\n`,
    "utf8",
  )
  await scroll(0)
}
