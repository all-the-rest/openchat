import type { AppServer, AppSkill, AppsResponse } from "@openchat/contracts"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AppsRoute } from "../src/App"
import { AppsPage } from "../src/apps/AppsPage"
import { SurfaceProvider } from "../src/code/SurfaceProvider"
import { I18nProvider } from "../src/i18n/provider"
import { ThemeProvider } from "../src/theme/provider"

const fetchMock = vi.fn()

interface InfoFixture {
  code: { configured: boolean; expectedVersion: string }
  apps: { available: boolean }
}

let fixture: AppsResponse
let info: InfoFixture
let reads: number
/** A one-shot response for the next action POST. */
let actionFailure: Response | null
/** Defers the action POST so a test can inspect the busy button. */
let actionGate: (() => Promise<Response>) | null
/** Defers the `/api/apps` read, for the loading and retry states. */
let appsRead: (() => Promise<Response> | Response) | null

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function noContent(): Response {
  return new Response(null, { status: 204 })
}

function error(status: number, code: string, headers: HeadersInit = {}): Response {
  return json({ error: { code, message: "upstream detail" } }, status, headers)
}

function server(overrides: Partial<AppServer> & { name: string }): AppServer {
  return { status: "connected", ...overrides }
}

beforeEach(() => {
  reads = 0
  actionFailure = null
  actionGate = null
  appsRead = null
  fixture = { available: true, servers: [], skills: [] }
  info = {
    code: { configured: true, expectedVersion: "2.3.0" },
    apps: { available: true },
  }

  fetchMock.mockReset()
  fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as Request).url)
    const method = init?.method ?? "GET"

    if (url === "/api/info") return json(info)
    if (url === "/api/apps" && method === "GET") {
      reads += 1
      return appsRead ? appsRead() : json(fixture)
    }

    const match = /^\/api\/apps\/([^/]+)\/(connect|disconnect)$/.exec(url)
    if (match && method === "POST") {
      if (actionGate) return actionGate()
      if (actionFailure) return actionFailure
      const name = decodeURIComponent(match[1] ?? "")
      const action = match[2]
      fixture = {
        ...fixture,
        servers: fixture.servers.map((entry) =>
          entry.name === name
            ? { ...entry, status: action === "connect" ? "connected" : "pending" }
            : entry,
        ),
      }
      return noContent()
    }

    throw new Error(`unexpected request: ${method} ${url}`)
  })
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function providers(children: ReactNode) {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale="en">
        <MemoryRouter initialEntries={["/apps"]}>{children}</MemoryRouter>
      </I18nProvider>
    </ThemeProvider>,
  )
}

function renderPage() {
  return providers(
    <Routes>
      <Route path="/apps" element={<AppsPage />} />
    </Routes>,
  )
}

function renderRoute() {
  return providers(
    <SurfaceProvider>
      <Routes>
        <Route path="/apps" element={<AppsRoute />} />
        <Route path="/" element={<p>chat home</p>} />
      </Routes>
    </SurfaceProvider>,
  )
}

/** The list item that carries the server's title. */
function rowOf(title: string): HTMLElement {
  const row = screen.getByText(title).closest("li")
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${title}`)
  return row
}

describe("apps page", () => {
  it("renders every server status with the action the host allows", async () => {
    fixture.servers = [
      server({ name: "alpha", status: "connected" }),
      server({ name: "beta", status: "pending" }),
      server({ name: "gamma", status: "disabled" }),
      server({ name: "delta", status: "failed", error: "Handshake refused" }),
      server({ name: "epsilon", status: "needs_auth", error: "Token expired" }),
    ]
    renderPage()

    const servers = await screen.findByRole("region", { name: "Servers" })
    for (const status of ["Connected", "Pending", "Disabled", "Failed", "Needs auth"]) {
      expect(within(servers).getByText(status)).toBeInTheDocument()
    }

    // The accessible name names the row; the visible label stays short.
    expect(within(servers).getByRole("button", { name: "Disconnect alpha" })).toBeEnabled()
    expect(within(servers).getByRole("button", { name: "Disconnect beta" })).toBeEnabled()
    expect(within(servers).getByRole("button", { name: "Connect delta" })).toBeEnabled()
    expect(within(servers).getByRole("button", { name: "Connect epsilon" })).toBeEnabled()

    const disabled = rowOf("gamma")
    expect(within(disabled).queryByRole("button")).toBeNull()
    expect(within(disabled).getByText("Disabled in the host configuration.")).toBeInTheDocument()

    expect(within(servers).getByText("Handshake refused")).toBeInTheDocument()
    expect(within(servers).getByText("Token expired")).toBeInTheDocument()
    // A title is optional: an untitled server falls back to its name.
    expect(within(servers).getByText("alpha")).toBeInTheDocument()
    // The pinned host API cannot list tools, so no tools section is rendered.
    expect(screen.queryByRole("region", { name: "Tools" })).toBeNull()
  })

  it("connects with a host-valid name, re-reads the host and shows the new status", async () => {
    const user = userEvent.setup()
    fixture.servers = [
      server({ name: "github", title: "GitHub", status: "failed", error: "Needs a token" }),
    ]
    renderPage()

    await user.click(await screen.findByRole("button", { name: "Connect GitHub" }))

    await waitFor(() => expect(reads).toBe(2))
    const post = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/connect") && (init as RequestInit | undefined)?.method === "POST",
    )
    expect(String(post?.[0])).toBe("/api/apps/github/connect")
    expect(await screen.findByText("Connected")).toBeInTheDocument()
    expect(screen.getByTestId("apps-notice")).toHaveTextContent("GitHub connected.")
  })

  it("disconnects and shows the status the host reports next", async () => {
    const user = userEvent.setup()
    fixture.servers = [server({ name: "github", status: "connected" })]
    renderPage()

    await user.click(await screen.findByRole("button", { name: "Disconnect github" }))

    await waitFor(() => expect(reads).toBe(2))
    const post = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/disconnect") && (init as RequestInit | undefined)?.method === "POST",
    )
    expect(String(post?.[0])).toBe("/api/apps/github/disconnect")
    expect(await screen.findByText("Pending")).toBeInTheDocument()
    expect(screen.getByTestId("apps-notice")).toHaveTextContent("github disconnected.")
  })

  it("clears the success notice when the refresh after an action fails", async () => {
    const user = userEvent.setup()
    fixture.servers = [
      server({ name: "github", status: "failed", error: "Needs a token" }),
    ]
    let failRefresh = false
    appsRead = () => (failRefresh ? error(502, "apps_unavailable") : json(fixture))
    renderPage()

    const connect = await screen.findByRole("button", { name: "Connect github" })
    failRefresh = true
    await user.click(connect)

    // The action succeeded but its re-read did not: the outcome is unknown, so
    // the banner is the whole story and the row keeps the last known status.
    expect(await screen.findByText("The host did not answer.")).toBeInTheDocument()
    expect(screen.getByTestId("apps-notice")).toBeEmptyDOMElement()
    expect(screen.queryByText("github connected.")).toBeNull()
    expect(within(rowOf("github")).getByText("Failed")).toBeInTheDocument()
    expect(within(rowOf("github")).getByRole("button", { name: "Connect github" })).toBeEnabled()
  })

  it("disables the action button while its request runs", async () => {
    const user = userEvent.setup()
    fixture.servers = [server({ name: "github", status: "connected" })]
    let release!: (value: Response) => void
    actionGate = () => new Promise<Response>((done) => (release = done))
    renderPage()

    const disconnect = await screen.findByRole("button", { name: "Disconnect github" })
    await user.click(disconnect)
    await waitFor(() => expect(disconnect).toBeDisabled())

    await act(async () => release(noContent()))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Disconnect github" })).toBeEnabled(),
    )
  })

  it("tells an unknown server apart and keeps the row", async () => {
    const user = userEvent.setup()
    fixture.servers = [server({ name: "github", status: "failed", error: "Needs a token" })]
    actionFailure = error(404, "apps_unknown_server")
    renderPage()

    await user.click(await screen.findByRole("button", { name: "Connect github" }))

    expect(await screen.findByText("This server is no longer configured.")).toBeInTheDocument()
    expect(screen.getByText("github")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Connect github" })).toBeEnabled()
    expect(reads).toBe(1)
  })

  it("reports a disabled server and a host that did not answer", async () => {
    const user = userEvent.setup()
    fixture.servers = [server({ name: "github", status: "failed" })]
    actionFailure = error(409, "apps_disabled")
    renderPage()

    await user.click(await screen.findByRole("button", { name: "Connect github" }))
    const banner = await screen.findByRole("alert")
    expect(banner).toHaveTextContent("Disabled in the host configuration.")
    // The upstream message never leaks.
    expect(banner).not.toHaveTextContent("upstream detail")

    await user.click(within(banner).getByRole("button", { name: "Dismiss" }))
    actionFailure = error(502, "apps_unavailable")
    await user.click(screen.getByRole("button", { name: "Connect github" }))
    expect(await screen.findByText("The host did not answer.")).toBeInTheDocument()
  })

  it("surfaces Retry-After on a throttled action", async () => {
    const user = userEvent.setup()
    fixture.servers = [server({ name: "github", status: "failed" })]
    actionFailure = error(429, "too_many_requests", { "retry-after": "30" })
    renderPage()

    await user.click(await screen.findByRole("button", { name: "Connect github" }))

    expect(
      await screen.findByText("Too many attempts. Try again in 30 s."),
    ).toBeInTheDocument()
  })

  it("renders skills with an Auto badge and no action", async () => {
    fixture.skills = [
      { id: "s1", name: "Review", description: "Reviews a diff", autoinvoke: true },
      { id: "s2", name: "Summarize" },
    ] satisfies AppSkill[]
    renderPage()

    const skills = await screen.findByRole("region", { name: "Skills" })
    expect(within(skills).getByText("Review")).toBeInTheDocument()
    expect(within(skills).getByText("Reviews a diff")).toBeInTheDocument()
    expect(within(skills).getByText("Summarize")).toBeInTheDocument()
    expect(within(skills).getAllByTestId("apps-skill-auto")).toHaveLength(1)
    expect(within(skills).getByTestId("apps-skill-auto")).toHaveTextContent("Auto")
    expect(within(skills).queryByRole("button")).toBeNull()
  })

  it("announces empty servers and empty skills independently", async () => {
    renderPage()

    expect(await screen.findByText("No MCP servers are configured.")).toBeInTheDocument()
    expect(screen.getByText("No skills are available.")).toBeInTheDocument()
  })

  it("announces loading while the first read is in flight", async () => {
    let release!: (value: Response) => void
    appsRead = () => new Promise<Response>((done) => (release = done))
    renderPage()

    expect(await screen.findByTestId("apps-loading")).toHaveTextContent("Loading apps…")

    await act(async () => release(json(fixture)))
    expect(await screen.findByRole("region", { name: "Servers" })).toBeInTheDocument()
  })

  it("reports a failed list read and retries it", async () => {
    const user = userEvent.setup()
    let failFirst = true
    appsRead = () => {
      if (!failFirst) return json(fixture)
      failFirst = false
      return error(502, "apps_unavailable")
    }
    renderPage()

    expect(await screen.findByText("Apps could not be loaded.")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Retry" }))

    expect(await screen.findByRole("region", { name: "Servers" })).toBeInTheDocument()
    expect(reads).toBe(2)
  })

  it("shows the unavailable note when the capability disappears after /api/info", async () => {
    fixture.available = false
    renderRoute()

    expect(
      await screen.findByText("Apps are not available in this deployment."),
    ).toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "Servers" })).toBeNull()
  })

  it("redirects to chat when /api/info reports no app surface", async () => {
    info = { ...info, apps: { available: false } }
    renderRoute()

    expect(await screen.findByText("chat home")).toBeInTheDocument()
    expect(
      fetchMock.mock.calls.some(([url]) => String(url) === "/api/apps"),
    ).toBe(false)
  })
})
