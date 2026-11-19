import { describe, expect, it, vi } from "vitest"
import type { OpenCodeClient } from "@opencode/client"
import { LiveBackend } from "../src/live"

/**
 * OpenCode's `/prompt` endpoint stores `text` as a plain user message; slash
 * commands belong to the separate `/command` endpoint. The live adapter must
 * keep that contract even when the composer text starts with a slash.
 */
describe("live prompt command contract", () => {
  it("forwards leading-slash text verbatim to session.prompt, never to session.command", async () => {
    const prompt = vi.fn(async () => ({ id: "msg_live" }))
    const command = vi.fn()
    const client = {
      session: { prompt, command },
    } as unknown as OpenCodeClient

    const backend = new LiveBackend({
      baseUrl: "http://unused",
      password: "unused",
      workspace: "/workspace",
      client,
    })

    const text =
      "/goal alle änderungen sind entweder explizit verworfen oder in origin main gemergt, ci grün"
    const result = await backend.prompt("ses_live", { text })

    expect(prompt).toHaveBeenCalledOnce()
    expect(prompt).toHaveBeenCalledWith({
      sessionID: "ses_live",
      text,
      id: null,
      delivery: null,
    })
    expect(command).not.toHaveBeenCalled()
    expect(result).toEqual({ messageID: "msg_live" })
  })
})
