import { render, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { SessionsProvider, useSessions } from "../src/chat/sessions"

const mocks = vi.hoisted(() => ({ listSessions: vi.fn() }))

vi.mock("../src/api/client", () => ({ api: mocks }))

interface SurfaceBox {
  surface: "chat" | "code"
  hostReachable: boolean | null
}

// The provider only reads `surface` and `hostReachable`; a mutable box lets a
// test switch surfaces by re-rendering the same tree.
const surfaceState = vi.hoisted(() => ({
  values: null as SurfaceBox | null,
}))

vi.mock("../src/code/SurfaceProvider", () => ({
  useSurfaceOrNull: () => surfaceState.values,
  Skeleton: () => null,
}))

function Probe() {
  const { sessions, loading } = useSessions()
  return (
    <output data-testid="count" data-loading={loading}>
      {sessions.length}
    </output>
  )
}

function tree() {
  return (
    <SessionsProvider>
      <Probe />
    </SessionsProvider>
  )
}

beforeEach(() => {
  mocks.listSessions.mockReset()
  mocks.listSessions.mockResolvedValue([])
  surfaceState.values = { surface: "chat", hostReachable: true }
})

describe("session list on surface switches", () => {
  it("refreshes once when Code switches back to Chat", async () => {
    surfaceState.values = { surface: "code", hostReachable: true }
    const { rerender } = render(tree())
    await waitFor(() => expect(mocks.listSessions).toHaveBeenCalledTimes(1))

    // Staying in Code triggers nothing.
    rerender(tree())
    expect(mocks.listSessions).toHaveBeenCalledTimes(1)

    surfaceState.values = { surface: "chat", hostReachable: true }
    rerender(tree())
    await waitFor(() => expect(mocks.listSessions).toHaveBeenCalledTimes(2))

    // Chat to chat is not a switch; no polling, no extra request.
    rerender(tree())
    expect(mocks.listSessions).toHaveBeenCalledTimes(2)
  })

  it("does not refresh on Chat to Code in the other direction", async () => {
    const { rerender } = render(tree())
    await waitFor(() => expect(mocks.listSessions).toHaveBeenCalledTimes(1))

    surfaceState.values = { surface: "code", hostReachable: true }
    rerender(tree())
    await waitFor(() => expect(mocks.listSessions).toHaveBeenCalledTimes(1))
  })
})
