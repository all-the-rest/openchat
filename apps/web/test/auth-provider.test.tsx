import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AuthProvider, useAuth } from "../src/auth/provider"

const fetchMock = vi.fn()

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** Minimal consumer: exposes the state and triggers the login. */
function Probe() {
  const auth = useAuth()
  return (
    <div>
      <p data-testid="status">{auth.status}</p>
      <p data-testid="user">{auth.user ?? "anonymous"}</p>
      <button type="button" onClick={() => void auth.signIn("owner", "secret")}>
        sign in
      </button>
    </div>
  )
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation((url: string) => {
    if (url === "/api/auth/me") {
      return Promise.resolve(
        jsonResponse({ error: { code: "unauthorized", message: "Authentication required" } }, 401),
      )
    }
    if (url === "/api/auth/login") return Promise.resolve(jsonResponse({ user: "owner" }))
    return Promise.reject(new Error(`unexpected request: ${url}`))
  })
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("AuthProvider", () => {
  it("sends the username and password and records the authenticated user", async () => {
    const user = userEvent.setup()
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("unauthenticated"))
    await user.click(screen.getByRole("button", { name: "sign in" }))

    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("owner"))
    expect(screen.getByTestId("status")).toHaveTextContent("authenticated")

    const loginCall = fetchMock.mock.calls.find(([url]) => url === "/api/auth/login")
    const init = loginCall?.[1] as RequestInit | undefined
    expect(JSON.parse(String(init?.body))).toEqual({ user: "owner", password: "secret" })
  })
})
