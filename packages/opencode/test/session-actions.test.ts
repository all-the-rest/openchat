import { EVENT } from "@openchat/contracts"
import type { EventEnvelope, FormRequest } from "@openchat/contracts"
import { describe, expect, it } from "vitest"
import { FakeBackend } from "../src"

function backend(): FakeBackend {
  return new FakeBackend({ delayMs: 0, now: () => 1_000 })
}

describe("fake session rename and delete", () => {
  it("renames a chat and reports the new row", async () => {
    const fake = backend()
    const session = await fake.createSession({ title: "Old title", directory: "/workspace" })

    const renamed = await fake.renameSession(session.id, "  New title  ")
    expect(renamed.title).toBe("New title")
    expect(renamed.id).toBe(session.id)
    expect(renamed.updated).toBe(1_000)

    const listed = await fake.listSessions()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.title).toBe("New title")
  })

  it("refuses to rename an unknown chat or set an empty title", async () => {
    const fake = backend()
    const session = await fake.createSession({ directory: "/workspace" })

    await expect(fake.renameSession("ses_missing", "Title")).rejects.toMatchObject({
      code: "not_found",
    })
    await expect(fake.renameSession(session.id, "   ")).rejects.toMatchObject({
      code: "invalid",
    })
    expect((await fake.listSessions())[0]?.title).toBe("")
  })

  it("deletes a chat and refuses an unknown one", async () => {
    const fake = backend()
    const first = await fake.createSession({ title: "First", directory: "/workspace" })
    const second = await fake.createSession({ title: "Second", directory: "/workspace" })

    await fake.deleteSession(first.id)
    expect((await fake.listSessions()).map((entry) => entry.id)).toEqual([second.id])

    await expect(fake.deleteSession(first.id)).rejects.toMatchObject({ code: "not_found" })
  })

  it("drops a streaming chat without failing on its next scripted step", async () => {
    const fake = backend()
    const session = await fake.createSession({ directory: "/workspace" })
    await fake.prompt(session.id, { text: "slow: take your time" })

    await fake.deleteSession(session.id)
    expect(await fake.listSessions()).toEqual([])
  })
})

describe("fake forms", () => {
  it("seeds one open form and removes it on a reply", async () => {
    const fake = backend()
    const session = await fake.createSession({ directory: "/workspace" })

    const form = fake.seedForm(session.id)
    expect(form.id).toBe("frm_1")
    expect(form.sessionID).toBe(session.id)
    expect(form.fields.map((field) => field.type)).toEqual(["string", "string", "boolean"])

    expect(await fake.listForms(session.id)).toEqual([form])

    await fake.replyForm(session.id, form.id, {
      summary: "The three largest costs",
      tone: "brief",
      confirm: true,
    })
    expect(await fake.listForms(session.id)).toEqual([])

    await expect(
      fake.replyForm(session.id, form.id, { summary: "again" }),
    ).rejects.toMatchObject({ code: "not_found" })
  })

  it("emits form.created and form.replied for the event stream", async () => {
    const fake = backend()
    const session = await fake.createSession({ directory: "/workspace" })
    const controller = new AbortController()
    const iterator = fake.subscribe(controller.signal)[Symbol.asyncIterator]()

    const form = fake.seedForm(session.id)
    const created = (await iterator.next()).value as EventEnvelope
    expect(created.type).toBe(EVENT.formCreated)
    expect((created.data.form as FormRequest).id).toBe(form.id)

    await fake.replyForm(session.id, form.id, { summary: "Done" })
    const replied = (await iterator.next()).value as EventEnvelope
    expect(replied.type).toBe(EVENT.formReplied)
    expect(replied.data.id).toBe(form.id)
    expect(replied.data.answer).toEqual({ summary: "Done" })

    controller.abort()
  })

  it("rejects forms for unknown sessions", async () => {
    const fake = backend()
    await expect(fake.listForms("ses_missing")).rejects.toMatchObject({ code: "not_found" })
    expect(() => fake.seedForm("ses_missing")).toThrow("Unknown session")
    await expect(
      fake.replyForm("ses_missing", "frm_1", { summary: "x" }),
    ).rejects.toMatchObject({ code: "not_found" })
  })
})
