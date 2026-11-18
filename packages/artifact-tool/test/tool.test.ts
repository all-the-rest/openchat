import { describe, expect, it } from "vitest"
import type { FetchLike } from "../src/bff"
import { statusError, writeUrl } from "../src/bff"
import { writeApp } from "../src/tool"
import type { WriteResult } from "../src/tool"

const BFF = "http://bff.example:8787"
const TOKEN = "test-internal-token-0123456789abcdef"
const RECEIPT = { artifactID: "b".repeat(64), title: "Counter", bytes: 24_000 }

const APP = `function App() {
  const [count, setCount] = useState(0)
  return <button onClick={() => setCount(count + 1)}>{count}</button>
}`

interface Call {
  url: string
  init: RequestInit
}

function stub(response: Response | (() => Promise<Response>)): {
  fetchImpl: FetchLike
  calls: Call[]
} {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init })
    if (typeof response === "function") return response()
    return response
  }
  return { fetchImpl, calls }
}

function ok(): Response {
  return new Response(JSON.stringify(RECEIPT), {
    status: 201,
    headers: { "content-type": "application/json" },
  })
}

async function write(fetchImpl: FetchLike, input: unknown = { title: "Counter", code: APP }) {
  return writeApp(input, { bffUrl: BFF, token: TOKEN, fetch: fetchImpl })
}

function failure(result: WriteResult): string {
  if (result.ok) throw new Error("expected a failure")
  return result.error
}

describe("openchat_app_write: happy path", () => {
  it("returns the receipt and no HTML", async () => {
    const { fetchImpl, calls } = stub(ok())
    const result = await write(fetchImpl)
    expect(result).toEqual({ ok: true, value: RECEIPT })
    expect(calls).toHaveLength(1)
  })

  it("posts one JSON envelope with the compiled document", async () => {
    const { fetchImpl, calls } = stub(ok())
    await write(fetchImpl, { title: "Counter", code: APP, css: "body { color: red }" })
    const call = calls[0]
    if (!call) throw new Error("no request was made")
    expect(call.url).toBe(`${BFF}/internal/artifacts`)
    expect(call.init.method).toBe("POST")
    expect(call.init.redirect).toBe("manual")
    expect(call.init.credentials).toBe("omit")
    const headers = call.init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(headers["content-type"]).toBe("application/json")

    const body = JSON.parse(String(call.init.body)) as { title: string; html: string }
    expect(body.title).toBe("Counter")
    expect(body.html.startsWith("<!doctype html")).toBe(true)
    expect(body.html).toContain('<div id="root"></div>')
    expect(body.html).toContain("<style>body { color: red }</style>")
    expect(body.html).toContain("document.getElementById(\"root\")")
    expect(body.html).not.toContain("window.openchat")
    expect(body.html.toLowerCase()).not.toContain("https:")
  })

  it("strips a trailing slash from the BFF URL", () => {
    expect(writeUrl("http://bff.example:8787/")).toBe("http://bff.example:8787/internal/artifacts")
    expect(writeUrl("http://bff.example:8787/bff")).toBe(
      "http://bff.example:8787/bff/internal/artifacts",
    )
  })
})

describe("openchat_app_write: validation stops before the network", () => {
  it("returns the validator message and never calls fetch", async () => {
    const { fetchImpl, calls } = stub(ok())
    const result = await write(fetchImpl, { title: "x", code: "const a = fetch('/x')" })
    expect(failure(result)).toBe("fetch: line 1")
    expect(calls).toHaveLength(0)
  })
})

describe("openchat_app_write: BFF status mapping", () => {
  it.each([
    [400, "internal: the BFF rejected the compiled document"],
    [401, "internal: the BFF rejected ARTIFACT_INTERNAL_TOKEN; the tool and the BFF must share the same value"],
    [403, "internal: the BFF rejected ARTIFACT_INTERNAL_TOKEN; the tool and the BFF must share the same value"],
    [413, "size: the compiled document exceeds the BFF body limit"],
    [415, "internal: the BFF refused the request media type"],
    [429, "busy: the artifact write budget is exhausted; retry in a minute"],
    [503, "unavailable: the BFF has no artifact storage configured"],
    [500, "internal: the BFF answered 500"],
    [418, "internal: the BFF answered 418"],
  ])("maps %i to a fixed message", async (status, message) => {
    const { fetchImpl } = stub(
      new Response(JSON.stringify({ error: { code: "x", message: "UPSTREAM-TEXT" } }), {
        status,
        headers: { "content-type": "application/json" },
      }),
    )
    const result = await write(fetchImpl)
    expect(failure(result)).toBe(message)
    expect(failure(result)).not.toContain("UPSTREAM-TEXT")
  })

  it("exposes the same mapping as a function", () => {
    expect(statusError(404)).toBe("internal: the BFF answered 404")
  })

  it("refuses a redirect instead of following it", async () => {
    const { fetchImpl, calls } = stub(
      new Response(null, { status: 302, headers: { location: "http://evil.example/" } }),
    )
    const result = await write(fetchImpl)
    expect(failure(result)).toBe("internal: the BFF redirected the write")
    expect(calls[0]?.init.redirect).toBe("manual")
  })

  it("reports an unreachable BFF", async () => {
    const { fetchImpl } = stub(async () => {
      throw new TypeError("fetch failed")
    })
    expect(failure(await write(fetchImpl))).toBe(
      "unreachable: the BFF did not answer; check OPENCHAT_BFF_URL",
    )
  })

  it.each([
    ["a non-JSON body", new Response("not json", { status: 201 })],
    ["a body without a receipt", new Response(JSON.stringify({ ok: true }), { status: 201 })],
    ["a receipt with a bad byte count", new Response(JSON.stringify({ ...RECEIPT, bytes: -1 }), { status: 201 })],
    ["a receipt without an id", new Response(JSON.stringify({ title: "x", bytes: 1 }), { status: 201 })],
    ["a JSON array", new Response(JSON.stringify([RECEIPT]), { status: 201 })],
  ])("rejects %s", async (_label, response) => {
    const { fetchImpl } = stub(response)
    expect(failure(await write(fetchImpl))).toBe("internal: the BFF answered an unexpected body")
  })
})
