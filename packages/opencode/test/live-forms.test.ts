import { describe, expect, it, vi } from "vitest"
import type { FormRequest } from "@openchat/contracts"
import type { OpenCodeClient } from "@opencode/client"
import { normalizeEvent } from "../src/live-events"
import { listHostForms, replyHostForm } from "../src/live-forms"
import { event } from "./live-helpers"

/**
 * A host payload the pinned types allow but an HTML card cannot render: the
 * numeric bounds are the JSON-safe `"Infinity"`/`"-Infinity"`/`"NaN"` strings
 * and one field names a variant this client does not know.
 */
const weirdHostForm = {
  id: "frm_weird",
  sessionID: "ses_live",
  title: "Weird form",
  fields: [
    {
      key: "count",
      type: "number",
      title: "How many?",
      minimum: "Infinity",
      maximum: "-Infinity",
      default: "NaN",
    },
    { key: "mystery", type: "mystery", title: "Unknown variant" },
    {
      key: "note",
      type: "string",
      title: "Note",
      minLength: "NaN",
      maxLength: "Infinity",
      default: 7,
    },
  ],
}

function client(): OpenCodeClient {
  return {
    session: {
      form: {
        list: async () => [weirdHostForm],
      },
    },
  } as unknown as OpenCodeClient
}

describe("normalizeForm", () => {  it("drops non-finite bounds and unknown field variants from a host payload", async () => {
    const [form] = await listHostForms(client(), "ses_live")

    expect(form).toEqual({
      id: "frm_weird",
      sessionID: "ses_live",
      title: "Weird form",
      fields: [
        { key: "count", type: "number", title: "How many?" },
        { key: "note", type: "string", title: "Note" },
      ],
    } satisfies FormRequest)
  })

  it("normalizes form.created through the same path as listForms", async () => {
    const [listed] = await listHostForms(client(), "ses_live")
    const created = normalizeEvent(
      event({ type: "form.created", data: { form: weirdHostForm } }),
    )

    expect(created.type).toBe("form.created")
    // Reload and event cannot disagree about the card, even for a host payload
    // that carries values the browser cannot render.
    expect(created.data.form).toEqual(listed)
    expect((created.data.form as FormRequest).fields.map((field) => field.key)).toEqual([
      "count",
      "note",
    ])
  })

  it("keeps an unknown form.created payload out of the normalized fields", () => {
    const created = normalizeEvent(
      event({
        type: "form.created",
        data: {
          form: {
            ...weirdHostForm,
            fields: [{ key: "mystery", type: "mystery" }],
          },
        },
      }),
    )

    expect((created.data.form as FormRequest).fields).toEqual([])
  })
})

describe("replyHostForm pre-read", () => {
  function replyClient(
    get: () => Promise<unknown>,
    replyImpl: () => Promise<unknown> = async () => {},
  ) {
    const reply = vi.fn(replyImpl)
    const client = {
      session: { form: { get, reply } },
    } as unknown as OpenCodeClient
    return { client, reply }
  }

  it("maps a failed pre-read to unavailable instead of a missing form", async () => {
    const { client, reply } = replyClient(async () => {
      throw new Error("socket hang up")
    })

    await expect(
      replyHostForm(client, "ses_live", "frm_live", { summary: "Costs" }),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: "The host did not read the form",
    })
    expect(reply).not.toHaveBeenCalled()
  })

  it("keeps an explicitly missing form a not_found", async () => {
    const { client, reply } = replyClient(async () => {
      throw Object.assign(new Error("form not found"), { _tag: "FormNotFoundError" })
    })

    await expect(
      replyHostForm(client, "ses_live", "frm_missing", { summary: "Costs" }),
    ).rejects.toMatchObject({ code: "not_found" })
    expect(reply).not.toHaveBeenCalled()
  })

  it("treats an undeclared 404 status as a missing form", async () => {
    const { client, reply } = replyClient(async () => {
      throw Object.assign(new Error("UnexpectedStatus: 404"), {
        reason: "UnexpectedStatus",
        cause: { status: 404 },
      })
    })

    await expect(
      replyHostForm(client, "ses_live", "frm_missing", { summary: "Costs" }),
    ).rejects.toMatchObject({ code: "not_found" })
    expect(reply).not.toHaveBeenCalled()
  })

  it("maps a failed reply to unavailable instead of an unexpected error", async () => {
    const { client, reply } = replyClient(
      async () => ({ state: { status: "open" } }),
      async () => {
        throw new Error("connection reset")
      },
    )

    await expect(
      replyHostForm(client, "ses_live", "frm_live", { summary: "Costs" }),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: "The host did not answer the form reply",
    })
    expect(reply).toHaveBeenCalledTimes(1)
  })

  it("keeps a form settled between the pre-read and the reply a 409", async () => {
    const { client, reply } = replyClient(
      async () => ({ state: { status: "open" } }),
      async () => {
        throw Object.assign(new Error("form already settled"), {
          _tag: "FormAlreadySettledError",
        })
      },
    )

    await expect(
      replyHostForm(client, "ses_live", "frm_live", { summary: "Costs" }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "Form frm_live has already been answered",
    })
    expect(reply).toHaveBeenCalledTimes(1)
  })

  it("treats an undeclared 409 status on the reply as settled", async () => {
    const { client } = replyClient(
      async () => ({ state: { status: "open" } }),
      async () => {
        throw Object.assign(new Error("UnexpectedStatus: 409"), {
          reason: "UnexpectedStatus",
          cause: { status: 409 },
        })
      },
    )

    await expect(
      replyHostForm(client, "ses_live", "frm_live", { summary: "Costs" }),
    ).rejects.toMatchObject({ code: "conflict" })
  })

  it("keeps a rejected answer an invalid 400 and never echoes host text", async () => {
    const { client } = replyClient(
      async () => ({ state: { status: "open" } }),
      async () => {
        throw Object.assign(new Error("field tone is required: <script>alert(1)</script>"), {
          _tag: "FormInvalidAnswerError",
          message: "field tone is required: <script>alert(1)</script>",
        })
      },
    )

    const rejection = await replyHostForm(client, "ses_live", "frm_live", {
      summary: "Costs",
    }).catch((error: unknown) => error)

    expect(rejection).toMatchObject({
      code: "invalid",
      message: "The answer to form frm_live was rejected",
    })
    expect((rejection as Error).message).not.toContain("script")
  })

  it("keeps a form that vanished before the reply a not_found", async () => {
    const { client } = replyClient(
      async () => ({ state: { status: "open" } }),
      async () => {
        throw Object.assign(new Error("form not found"), { _tag: "FormNotFoundError" })
      },
    )

    await expect(
      replyHostForm(client, "ses_live", "frm_live", { summary: "Costs" }),
    ).rejects.toMatchObject({
      code: "not_found",
      message: "Unknown form: frm_live",
    })
  })

  it("treats an undeclared 400 status on the reply as an invalid answer", async () => {
    const { client } = replyClient(
      async () => ({ state: { status: "open" } }),
      async () => {
        throw Object.assign(new Error("UnexpectedStatus: 400"), {
          reason: "UnexpectedStatus",
          cause: { status: 400 },
        })
      },
    )

    await expect(
      replyHostForm(client, "ses_live", "frm_live", { summary: "Costs" }),
    ).rejects.toMatchObject({ code: "invalid" })
  })

  it("keeps a 5xx on the reply an unavailable host", async () => {
    const { client } = replyClient(
      async () => ({ state: { status: "open" } }),
      async () => {
        throw Object.assign(new Error("UnexpectedStatus: 503"), {
          reason: "UnexpectedStatus",
          cause: { status: 503 },
        })
      },
    )

    await expect(
      replyHostForm(client, "ses_live", "frm_live", { summary: "Costs" }),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: "The host did not answer the form reply",
    })
  })
})
