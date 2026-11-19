import type { MemoryOp } from "@openchat/contracts"
import { describe, expect, it } from "vitest"
import { memoryUrl, postOp, statusError } from "../src/bff"
import type { FetchLike } from "../src/bff"

const TOKEN = "bff-memory-token-0123456789"
const OP = { op: "find", queries: ["preference", "travel"], limit: 5 } as unknown as MemoryOp

function client(response: Response | Error): { fetch: FetchLike; calls: Array<[string, RequestInit]> } {
  const calls: Array<[string, RequestInit]> = []
  const fetch: FetchLike = async (input, init) => {
    calls.push([input, init])
    if (response instanceof Error) throw response
    return response
  }
  return { fetch, calls }
}

function options(fetch: FetchLike) {
  return { bffUrl: "http://bff:8787/", token: TOKEN, fetch }
}

describe("bff memory URL", () => {
  it("joins the base without a double slash", () => {
    expect(memoryUrl("http://bff:8787/")).toBe("http://bff:8787/internal/memory")
    expect(memoryUrl("https://chat.example.com/bff")).toBe(
      "https://chat.example.com/bff/internal/memory",
    )
  })
})

describe("bff postOp request shape", () => {
  it("sends the exact URL, headers and body with no credentials", async () => {
    const { fetch, calls } = client(new Response('{"rows":[]}', { status: 200 }))
    const result = await postOp(options(fetch), OP)
    expect(result).toEqual({ ok: true, result: { rows: [] } })
    expect(calls).toHaveLength(1)

    const [url, init] = calls[0] as [string, RequestInit]
    expect(url).toBe("http://bff:8787/internal/memory")
    expect(init.method).toBe("POST")
    expect(init.redirect).toBe("manual")
    expect(init.credentials).toBe("omit")
    expect(init.headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${TOKEN}`,
    })
    expect(init.body).toBe(JSON.stringify(OP))
  })

  it("accepts a 201 as a success and returns compact JSON", async () => {
    const { fetch } = client(new Response('{"ids":["m1"]}', { status: 201 }))
    expect(await postOp(options(fetch), OP)).toEqual({ ok: true, result: { ids: ["m1"] } })
  })
})

describe("bff postOp status mapping", () => {
  it.each([
    [400, "internal: the BFF rejected the memory operation"],
    [401, "internal: the BFF rejected MEMORY_INTERNAL_TOKEN; the tool and the BFF must share the same value"],
    [403, "internal: the BFF rejected MEMORY_INTERNAL_TOKEN; the tool and the BFF must share the same value"],
    [413, "size: the memory operation exceeds the BFF body limit"],
    [415, "internal: the BFF refused the request media type"],
    [429, "busy: the memory operation budget is exhausted; retry in a minute"],
    [503, "unavailable: the BFF has no memory store configured"],
    [500, "internal: the BFF answered 500"],
  ])("maps status %i to one fixed line", async (status, error) => {
    const { fetch } = client(new Response("oops", { status }))
    expect(await postOp(options(fetch), OP)).toEqual({ ok: false, error })
    expect(statusError(status)).toBe(error)
  })

  it("refuses a redirect instead of following the token", async () => {
    const { fetch } = client(
      new Response("", { status: 302, headers: { location: "http://elsewhere.test/" } }),
    )
    expect(await postOp(options(fetch), OP)).toEqual({
      ok: false,
      error: "internal: the BFF redirected the memory call",
    })
  })

  it("maps a transport failure without echoing the underlying message", async () => {
    const { fetch } = client(new Error(`ECONNREFUSED to 10.0.0.5 with ${TOKEN}`))
    const result = await postOp(options(fetch), OP)
    expect(result).toEqual({
      ok: false,
      error: "unreachable: the BFF did not answer; check OPENCHAT_BFF_URL",
    })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
    expect(JSON.stringify(result)).not.toContain("10.0.0.5")
  })

  it("rejects a non-JSON body without echoing upstream HTML", async () => {
    const html = "<html><body>502 Bad Gateway secret</body></html>"
    const { fetch } = client(new Response(html, { status: 200, headers: { "content-type": "text/html" } }))
    const result = await postOp(options(fetch), OP)
    expect(result).toEqual({ ok: false, error: "internal: the BFF answered an unexpected body" })
    expect(JSON.stringify(result)).not.toContain("Bad Gateway")
    expect(JSON.stringify(result)).not.toContain("<html>")
  })

  it("never echoes the token in an error", async () => {
    const { fetch } = client(new Response("denied", { status: 401 }))
    const result = await postOp(options(fetch), OP)
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })
})
