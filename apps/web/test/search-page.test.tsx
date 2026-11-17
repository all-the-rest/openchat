import type { SearchResponse } from "@openchat/contracts"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Link } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { deferred, renderSearch, response } from "./search-helpers"

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
}))

vi.mock("../src/api/client", () => ({ api: mocks }))

beforeEach(() => {
  mocks.search.mockReset()
  mocks.search.mockResolvedValue(response())
})

describe("search page", () => {
  it("queries the URL query, groups hits and links a chat message", async () => {
    renderSearch("/search?scope=all&q=alpha")

    await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(1))
    expect(mocks.search.mock.calls[0]?.[0]).toMatchObject({
      query: "alpha",
      sources: ["chats", "workspace", "web", "apps"],
    })

    const link = await screen.findByRole("link", { name: /We talked about alpha yesterday/ })
    expect(link).toHaveAttribute("href", "/c/ses_1/msg_1")
    expect(screen.getByRole("link", { name: /^Alpha chat$/ })).toHaveAttribute(
      "href",
      "/c/ses_1",
    )
    expect(screen.getAllByText("src/alpha.ts").length).toBeGreaterThan(0)
    expect(screen.getByText("Search failed")).toBeInTheDocument()
    expect(screen.getByText("Not configured")).toBeInTheDocument()
    expect(screen.getByText("3 found for “alpha”.")).toBeInTheDocument()
  })

  it("writes the query to the URL and removes it when cleared", async () => {
    const user = userEvent.setup()
    renderSearch("/search?scope=all&q=alpha")
    await screen.findAllByText("src/alpha.ts")

    const input = screen.getByLabelText("Search term")
    await user.clear(input)
    expect(screen.getByTestId("location").textContent).toBe("?scope=all")

    await user.type(input, "beta")
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("?scope=all&q=beta"),
    )
  })

  it("limits the input to the contract length", async () => {
    renderSearch("/search?scope=all&q=alpha")
    expect(screen.getByLabelText("Search term")).toHaveAttribute("maxlength", "200")
  })

  it("disables a source the host does not have", async () => {
    renderSearch("/search?scope=all&q=alpha")

    const web = await screen.findByTestId("search-source-web")
    await waitFor(() => expect(web).toBeDisabled())
    expect(web).not.toBeChecked()
    // The other sources stay switchable.
    expect(screen.getByTestId("search-source-chats")).toBeEnabled()
  })

  it("re-queries without a source when its toggle is switched off", async () => {
    const user = userEvent.setup()
    renderSearch("/search?scope=all&q=alpha")
    await screen.findAllByText("src/alpha.ts")

    await user.click(screen.getByTestId("search-source-chats"))

    await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(2))
    expect(mocks.search.mock.calls[1]?.[0]).toMatchObject({
      sources: ["workspace", "apps"],
    })
  })

  it("keeps at least one source selected", async () => {
    const user = userEvent.setup()
    renderSearch("/search?scope=all&q=alpha")
    await screen.findAllByText("src/alpha.ts")

    await user.click(screen.getByTestId("search-source-chats"))
    await user.click(screen.getByTestId("search-source-workspace"))

    await waitFor(() => expect(screen.getByTestId("search-source-apps")).toBeDisabled())
    expect(screen.getByTestId("search-source-apps")).toBeChecked()
  })

  it("keeps web out of a half-typed query until it is submitted", async () => {
    const user = userEvent.setup()
    // A deployment with a provider: web stays an option in the toggles.
    mocks.search.mockResolvedValue(
      response({
        available: ["chats", "workspace", "web", "apps"],
        groups: [
          { source: "chats", state: "ok", total: 0, hits: [] },
          { source: "workspace", state: "ok", total: 0, hits: [] },
          { source: "web", state: "ok", total: 0, hits: [] },
          { source: "apps", state: "ok", total: 0, hits: [] },
        ],
      }),
    )
    renderSearch("/search?scope=all&q=alpha")
    await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(1))

    const input = screen.getByLabelText("Search term")
    await user.clear(input)
    await user.type(input, "beta")

    await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(2))
    expect(mocks.search.mock.calls[1]?.[0].sources).toEqual(["chats", "workspace", "apps"])
    expect(screen.getByText("Web is searched when you press Enter.")).toBeInTheDocument()

    await user.keyboard("{Enter}")
    await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(3))
    expect(mocks.search.mock.calls[2]?.[0].sources).toEqual([
      "chats",
      "workspace",
      "web",
      "apps",
    ])
  })

  it("ignores an older response that lands after a newer one", async () => {
    const user = userEvent.setup()
    const first = deferred<SearchResponse>()
    const second = deferred<SearchResponse>()
    mocks.search.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    renderSearch("/search?scope=all&q=alpha")

    const input = screen.getByLabelText("Search term")
    await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(1))
    await user.clear(input)
    await user.type(input, "beta")
    await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(2))

    second.resolve(
      response({
        query: "beta",
        groups: [
          {
            source: "workspace",
            state: "ok",
            total: 1,
            hits: [{ source: "workspace", id: "file-beta", title: "beta.ts", path: "beta.ts" }],
          },
        ],
      }),
    )
    expect(await screen.findByText("beta.ts")).toBeInTheDocument()

    first.resolve(response())
    await new Promise((done) => setTimeout(done, 50))
    expect(screen.queryByText("src/alpha.ts")).not.toBeInTheDocument()
  })

  it("does not widen the selection when nothing is available", async () => {
    mocks.search.mockResolvedValue(response({ available: [], groups: [] }))
    renderSearch("/search?scope=all&q=alpha")

    expect(
      await screen.findByText("No source is available for this query."),
    ).toBeInTheDocument()
    // The empty selection must not trigger a second query.
    await new Promise((done) => setTimeout(done, 400))
    expect(mocks.search).toHaveBeenCalledTimes(1)
  })

  it("does not resend a source after availability narrowed", async () => {
    const user = userEvent.setup()
    mocks.search.mockResolvedValue(response({ available: [], groups: [] }))
    renderSearch("/search?scope=all&q=alpha")

    expect(
      await screen.findByText("No source is available for this query."),
    ).toBeInTheDocument()
    await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(1))

    const input = screen.getByLabelText("Search term")
    input.focus()
    await user.keyboard("{Enter}")
    await new Promise((done) => setTimeout(done, 400))
    expect(mocks.search).toHaveBeenCalledTimes(1)
  })

  it("applies a new scope on a same-route change", async () => {
    const user = userEvent.setup()
    renderSearch(
      "/search?scope=chats&q=alpha",
      <Link data-testid="scope-all" to="/search?scope=all&q=alpha">
        all
      </Link>,
    )
    await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(1))
    expect(mocks.search.mock.calls[0]?.[0].sources).toEqual(["chats"])

    await user.click(screen.getByTestId("scope-all"))
    await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(2))
    // The preset now holds all four; the request keeps only what the fixture
    // reports as available (no web provider in this response).
    expect(mocks.search.mock.calls[1]?.[0].sources).toEqual([
      "chats",
      "workspace",
      "apps",
    ])
  })

  it("renders hits of a failed group", async () => {
    mocks.search.mockResolvedValue(
      response({
        groups: [
          {
            source: "apps",
            state: "failed",
            total: 1,
            hits: [
              {
                source: "apps",
                id: "app-server-github",
                title: "GitHub",
                app: "github",
                appKind: "server",
                status: "needs_auth",
              },
            ],
          },
        ],
      }),
    )
    renderSearch("/search?scope=all&q=alpha")

    expect(await screen.findByText("GitHub")).toBeInTheDocument()
    expect(screen.getByText("Search failed")).toBeInTheDocument()
    // Known host statuses are translated instead of leaking the wire value.
    expect(screen.getByText(/Needs auth/)).toBeInTheDocument()
  })

  it("moves focus through the results with the arrow keys", async () => {
    const user = userEvent.setup()
    renderSearch("/search?scope=all&q=alpha")
    await screen.findAllByText("src/alpha.ts")

    const input = screen.getByLabelText("Search term")
    input.focus()
    await user.keyboard("{ArrowDown}")
    const links = screen
      .getAllByRole("link")
      .filter((element) => element.hasAttribute("data-search-result"))
    expect(document.activeElement).toBe(links[0])

    await user.keyboard("{ArrowDown}")
    expect(document.activeElement).toBe(links[1])

    // A non-actionable workspace hit is not a tab stop but is still reachable
    // with the arrow keys; before it was focusable the walk dead-ended here.
    await user.keyboard("{ArrowDown}")
    const row = screen
      .getAllByText("src/alpha.ts")
      .map((element) => element.closest("[data-search-result]"))
      .find((element) => element?.tagName === "DIV")
    expect(row).toBeTruthy()
    expect(document.activeElement).toBe(row)
    expect(row).toHaveAttribute("tabindex", "-1")

    await user.keyboard("{ArrowUp}")
    expect(document.activeElement).toBe(links[1])
    await user.keyboard("{ArrowUp}")
    expect(document.activeElement).toBe(links[0])
  })

  it("keeps bare /search chat-only and honours an explicit scope=all", async () => {
    const chatsOnly = renderSearch("/search?q=alpha")
    await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(1))
    expect(mocks.search.mock.calls[0]?.[0].sources).toEqual(["chats"])
    chatsOnly.unmount()

    mocks.search.mockClear()
    renderSearch("/search?scope=all&q=alpha")
    await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(1))
    expect(mocks.search.mock.calls[0]?.[0].sources).toEqual([
      "chats",
      "workspace",
      "web",
      "apps",
    ])
  })

  it("hides the web hint when the host has no provider", async () => {
    const user = userEvent.setup()
    renderSearch("/search?scope=all&q=alpha")
    await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(1))

    const input = screen.getByLabelText("Search term")
    await user.clear(input)
    await user.type(input, "beta")

    expect(screen.queryByText("Web is searched when you press Enter.")).not.toBeInTheDocument()
  })

  it("reports a failed query and retries it", async () => {
    const user = userEvent.setup()
    mocks.search.mockRejectedValueOnce(new Error("boom"))
    renderSearch("/search?scope=all&q=alpha")

    expect(await screen.findByText("The search failed.")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Retry" }))

    await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(2))
    expect((await screen.findAllByText("src/alpha.ts")).length).toBeGreaterThan(0)
  })

  it("shows the prompt without a query", async () => {
    renderSearch("/search?scope=all")
    expect(screen.getByText("Type a search term.")).toBeInTheDocument()
    expect(mocks.search).not.toHaveBeenCalled()
  })

  it("announces an empty result once, without empty group headings", async () => {
    mocks.search.mockResolvedValue(
      response({
        query: "nothing",
        available: ["chats", "workspace", "web", "apps"],
        groups: [
          { source: "chats", state: "ok", total: 0, hits: [] },
          { source: "workspace", state: "ok", total: 0, hits: [] },
          { source: "web", state: "ok", total: 0, hits: [] },
          { source: "apps", state: "ok", total: 0, hits: [] },
        ],
      }),
    )
    renderSearch("/search?scope=all&q=nothing")

    const messages = await screen.findAllByText("No results for “nothing”.")
    expect(messages).toHaveLength(1)
    expect(screen.queryByText("0 found")).not.toBeInTheDocument()
  })

  it("keeps a failed or disabled group visible when nothing matched", async () => {
    mocks.search.mockResolvedValue(
      response({
        query: "nothing",
        available: ["chats", "workspace", "apps"],
        groups: [
          { source: "chats", state: "ok", total: 0, hits: [] },
          { source: "workspace", state: "failed", total: 0, hits: [] },
          { source: "web", state: "disabled", total: 0, hits: [] },
          { source: "apps", state: "ok", total: 0, hits: [] },
        ],
      }),
    )
    renderSearch("/search?scope=all&q=nothing")

    expect(await screen.findByText("Search failed")).toBeInTheDocument()
    expect(screen.getByText("Not configured")).toBeInTheDocument()
    expect(screen.getAllByText("No results for “nothing”.")).toHaveLength(1)
  })
})
