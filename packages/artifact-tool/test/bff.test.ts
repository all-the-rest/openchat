import { describe, expect, it } from "vitest"
import { getDocument, readUrl, writeUrl } from "../src/bff"
import type { FetchLike } from "../src/bff"

/**
 * The read half of the internal BFF client. The Python tools read a template or
 * a source document by artifact id; the URL is built here, never from model
 * input, and a redirect is refused so the bearer token cannot travel.
 */

const ID = "a".repeat(64)
const TOKEN = "bff-token"

function client(response: Response | Error): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = []
  const fetch: FetchLike = async (input) => {
    calls.push(input)
    if (response instanceof Error) throw response
    return response
  }
  return { fetch, calls }
}

function options(fetch: FetchLike) {
  return { bffUrl: "http://bff:8787/", token: TOKEN, fetch }
}

describe("bff read URL", () => {
  it("joins the base without a double slash", () => {
    expect(writeUrl("http://bff:8787/")).toBe("http://bff:8787/internal/artifacts")
    expect(readUrl("http://bff:8787/", ID)).toBe(`http://bff:8787/internal/artifacts/${ID}`)
  })
})

describe("bff getDocument", () => {
  it("fetches the stored HTML with the bearer token and no credentials", async () => {
    const { fetch, calls } = client(new Response("<!doctype html><html></html>", { status: 200 }))
    const result = await getDocument(options(fetch), ID)
    expect(result).toEqual({ ok: true, html: "<!doctype html><html></html>" })
    expect(calls).toEqual([`http://bff:8787/internal/artifacts/${ID}`])
  })

  it("passes the fixed request shape", async () => {
    let init: RequestInit | undefined
    const fetch: FetchLike = async (_input, options) => {
      init = options
      return new Response("ok", { status: 200 })
    }
    await getDocument(options(fetch), ID)
    expect(init).toMatchObject({
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      headers: { accept: "text/html", authorization: `Bearer ${TOKEN}` },
    })
  })

  it("rejects a malformed id before any request", async () => {
    const { fetch, calls } = client(new Response("x", { status: 200 }))
    for (const id of ["", "A".repeat(64), "a".repeat(63), `a/${"b".repeat(64)}`]) {
      const result = await getDocument(options(fetch), id)
      expect(result).toEqual({ ok: false, error: "not_found: the artifact does not exist" })
    }
    expect(calls).toEqual([])
  })

  it.each([
    [404, "not_found: the artifact does not exist"],
    [401, "internal: the BFF rejected ARTIFACT_INTERNAL_TOKEN; the tool and the BFF must share the same value"],
    [503, "unavailable: the BFF has no artifact storage configured"],
  ])("maps status %i to one fixed line", async (status, error) => {
    const { fetch } = client(new Response("", { status }))
    expect(await getDocument(options(fetch), ID)).toEqual({ ok: false, error })
  })

  it("refuses a redirect instead of following the token", async () => {
    const { fetch } = client(
      new Response("", { status: 302, headers: { location: "http://elsewhere.test/" } }),
    )
    expect(await getDocument(options(fetch), ID)).toEqual({
      ok: false,
      error: "internal: the BFF redirected the read",
    })
  })

  it("maps a transport failure and an empty body without echoing either", async () => {
    const unreachable = client(new Error("ECONNREFUSED at 10.0.0.5"))
    expect(await getDocument(options(unreachable.fetch), ID)).toEqual({
      ok: false,
      error: "unreachable: the BFF did not answer; check OPENCHAT_BFF_URL",
    })

    const empty = client(new Response("", { status: 200 }))
    expect(await getDocument(options(empty.fetch), ID)).toEqual({
      ok: false,
      error: "internal: the BFF answered an unexpected body",
    })
  })
})
