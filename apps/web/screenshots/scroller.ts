// Scroll-container detection for the ui-review captures.
//
// Picks an explicitly configured inner container first, then the largest
// visible inner overflow container, and finally the window. Scrolling sets
// `scrollTop` directly so captures never race a smooth-scroll animation.

import type { Page } from "@playwright/test"

export interface UiReviewScroller {
  kind: "inner" | "window"
  selector: string | null
  viewportHeight: number
  /** 80 % of the viewport height, so consecutive sections overlap by 20 %. */
  step: number
  scrollTo: (y: number) => Promise<void>
  read: () => Promise<{ max: number; scrollY: number }>
}

interface DetectedScroller {
  kind: "inner" | "window"
  selector: string | null
  viewportHeight: number
  step: number
}

export async function detectScroller(
  page: Page,
  configuredSelector?: string,
): Promise<UiReviewScroller> {
  // A configured container is a hard requirement: wait for the route's chunk
  // to mount it instead of racing the lazy import.
  if (configuredSelector) {
    await page.locator(configuredSelector).first().waitFor({ state: "attached", timeout: 30_000 })
  }
  const detected = await page.evaluate((selector): DetectedScroller => {
    const doc = document.scrollingElement
    const winH = window.innerHeight
    const innerScroller = (element: HTMLElement, matchedSelector: string) => ({
      kind: "inner" as const,
      selector: matchedSelector,
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

    if (selector) {
      const element = document.querySelector<HTMLElement>(selector)
      if (!element) {
        throw new Error(`Scroll container selector "${selector}" matched no element`)
      }
      return innerScroller(element, selector)
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
  }, configuredSelector)

  const scrollTo = (y: number) =>
    page.evaluate(
      ({ kind, selector, target }) => {
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
      { kind: detected.kind, selector: detected.selector, target: y },
    )

  const read = () =>
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
      { kind: detected.kind, selector: detected.selector },
    )

  return { ...detected, scrollTo, read }
}
