import { describe, expect, it } from "vitest"
import { createDocumentsClient } from "../src/documents-client"

const DOCX = Buffer.from("filled-docx").toString("base64")
const PDF = Buffer.from("%PDF-1.7\nfake").toString("base64")
const OPTIONS = { url: "http://documents:8099", token: "secret" }

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })
}

function client(response: Response, seen: RequestInit[] = []) {
  const fetchImpl: typeof fetch = async (_input, init) => {
    seen.push(init ?? {})
    return response
  }
  return { client: createDocumentsClient({ ...OPTIONS, fetchImpl }), seen }
}

const FILL = { template: "PK-base64", values: { customer: "Ada" }, name: "invoice" }

describe("documents service client", () => {
  it("sends the bearer token and decodes both fill outputs", async () => {
    const { client: api, seen } = client(json({
      docx: DOCX,
      pdf: PDF,
      docxName: "invoice.docx",
      pdfName: "invoice.pdf",
    }))
    const result = await api.fill(FILL)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Buffer.from(result.value.docx).toString()).toBe("filled-docx")
      expect(Buffer.from(result.value.pdf).toString()).toContain("%PDF-")
    }
    expect(seen[0]?.method).toBe("POST")
    expect((seen[0]?.headers as Record<string, string>).Authorization).toBe("Bearer secret")
    expect(JSON.parse(String(seen[0]?.body))).toEqual(FILL)
  })

  it("maps a known service code to one fixed sentence", async () => {
    const { client: api } = client(json(
      { error: { code: "macro_document", message: "Traceback ... soffice.bin: fatal" } },
      400,
    ))
    expect(await api.fill(FILL)).toEqual({
      ok: false,
      error: "unsupported: macro-enabled documents are rejected",
    })
  })

  it("never returns a raw body, traceback or stderr", async () => {
    for (const response of [
      new Response("Traceback (most recent call last): javaldx error", { status: 500 }),
      json({ error: { code: "future_code", message: "soffice.bin: crash dump" } }, 500),
      json({ unexpected: true }),
    ]) {
      const { client: api } = client(response)
      const result = await api.fill(FILL)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).not.toMatch(/Traceback|javaldx|soffice|crash dump/)
    }
  })

  it("maps transport failures and oversized responses to stable codes", async () => {
    const down = createDocumentsClient({
      ...OPTIONS,
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.1:8099 internal detail")
      },
    })
    const result = await down.fill(FILL)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("documents service is unreachable")

    const timeoutError = new Error("aborted")
    timeoutError.name = "TimeoutError"
    const slow = createDocumentsClient({
      ...OPTIONS,
      fetchImpl: async () => {
        throw timeoutError
      },
    })
    const timed = await slow.convert({ document: DOCX, name: "a.docx" })
    expect(timed.ok).toBe(false)
    if (!timed.ok) expect(timed.error).toContain("ran longer than its limit")

    const { client: api } = client(json(
      { docx: DOCX, pdf: PDF, docxName: "a.docx", pdfName: "a.pdf" },
      200,
      { "Content-Length": "99999999" },
    ))
    expect(await api.fill(FILL)).toEqual({ ok: false, error: "size: the document exceeds the service limit" })
  })

  it("decodes a convert response", async () => {
    const { client: api } = client(json({ pdf: PDF, pdfName: "invoice.pdf" }))
    const result = await api.convert({ document: DOCX, name: "invoice" })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Buffer.from(result.value.pdf).toString()).toContain("%PDF-")
      expect(result.value.pdfName).toBe("invoice.pdf")
    }
  })
})
