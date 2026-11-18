import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { UpdateNotice } from "../src/components/UpdateNotice"
import { I18nProvider } from "../src/i18n/provider"
import { setStreamActive } from "../src/pwa/stream-guard"

const worker = {} as ServiceWorker

function renderNotice() {
  let publish: ((value: ServiceWorker | null) => void) | undefined
  const reload = vi.fn()
  const subscribe = (listener: (value: ServiceWorker | null) => void) => {
    publish = listener
    return () => {
      publish = undefined
    }
  }
  const view = render(
    <I18nProvider initialLocale="en">
      <UpdateNotice subscribe={subscribe} reload={reload} />
    </I18nProvider>,
  )
  const announce = (value: ServiceWorker | null) => {
    act(() => publish?.(value))
  }
  return { ...view, announce, reload }
}

afterEach(() => {
  act(() => setStreamActive(false))
})

describe("update notice", () => {
  it("stays hidden until a new worker is actually waiting", () => {
    const { announce } = renderNotice()
    expect(screen.queryByTestId("update-notice")).toBeNull()

    announce(null)
    expect(screen.queryByTestId("update-notice")).toBeNull()
  })

  it("shows the notice on a new version but never reloads by itself", () => {
    const { announce, reload } = renderNotice()
    announce(worker)

    expect(screen.getByTestId("update-notice")).toHaveTextContent("A new version is available")
    expect(screen.getByTestId("update-reload")).toBeEnabled()
    expect(reload).not.toHaveBeenCalled()
  })

  it("reloads only on an explicit button press", async () => {
    const user = userEvent.setup()
    const { announce, reload } = renderNotice()
    announce(worker)

    await user.click(screen.getByTestId("update-reload"))
    expect(reload).toHaveBeenCalledTimes(1)
    expect(reload).toHaveBeenCalledWith(worker)
  })

  it("can be dismissed until another version arrives", async () => {
    const user = userEvent.setup()
    const { announce } = renderNotice()
    announce(worker)

    await user.click(screen.getByTestId("update-dismiss"))
    expect(screen.queryByTestId("update-notice")).toBeNull()

    announce({} as ServiceWorker)
    expect(screen.getByTestId("update-notice")).toBeInTheDocument()
  })

  it("withholds the reload while an answer is streaming", () => {
    act(() => setStreamActive(true))
    const { announce } = renderNotice()
    announce(worker)

    expect(screen.getByTestId("update-reload")).toBeDisabled()
    expect(screen.getByTestId("update-notice")).toHaveTextContent(
      "Wait for the current answer to finish before reloading.",
    )

    act(() => setStreamActive(false))
    expect(screen.getByTestId("update-reload")).toBeEnabled()
  })
})
