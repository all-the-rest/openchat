import { describe, expect, it } from "vitest"
import { validateTool } from "../src/validate"

function errorOf(name: string, input: unknown): string {
  const result = validateTool(name, input)
  if (result.ok) throw new Error("expected a rejection")
  return result.error
}

describe("archive_list validation", () => {
  it("accepts a chat-relative .zip path", () => {
    expect(
      validateTool("archive_list", { zipPath: "session-1/files/bundle.zip" }),
    ).toMatchObject({
      ok: true,
      value: { name: "archive_list", value: { zipPath: "session-1/files/bundle.zip" } },
    })
  })

  it("rejects absolute, NUL, traversal and non-zip paths", () => {
    expect(errorOf("archive_list", { zipPath: "/workspace/chats/s.zip" })).toBe(
      "zipPath: use a path inside WORKSPACE_DIR/chats",
    )
    expect(errorOf("archive_list", { zipPath: "session-1/files/../s.zip" })).toBe(
      "zipPath: use a path inside WORKSPACE_DIR/chats",
    )
    expect(errorOf("archive_list", { zipPath: "session-1/files/a\u0000.zip" })).toBe(
      "zipPath: contains a control character",
    )
    expect(errorOf("archive_list", { zipPath: "session-1/files/a.tar.gz" })).toBe(
      "zipPath: must end with .zip",
    )
    expect(errorOf("archive_list", { zipPath: "session-1/bundle.zip" })).toBe(
      "zipPath: expected <sessionID>/files/<name>.zip",
    )
    expect(errorOf("archive_list", { zipPath: "session-1/files/.hidden.zip" })).toBe(
      "zipPath: the file name has an unsupported shape",
    )
    expect(errorOf("archive_list", {})).toBe("zipPath: must be a non-empty string")
  })
})

describe("archive_extract validation", () => {
  it("accepts a directory name made of safe characters", () => {
    expect(
      validateTool("archive_extract", {
        zipPath: "session-1/files/bundle.zip",
        directory: "bundle_2026-11",
      }),
    ).toMatchObject({
      ok: true,
      value: { name: "archive_extract", value: { directory: "bundle_2026-11" } },
    })
  })

  it("rejects separators, dots, leading punctuation and long names", () => {
    const call = (directory: unknown) =>
      errorOf("archive_extract", { zipPath: "session-1/files/bundle.zip", directory })
    expect(call("a/b")).toBe("directory: use letters, digits, dot, dash or underscore")
    expect(call("..")).toBe("directory: use letters, digits, dot, dash or underscore")
    expect(call("-dash")).toBe("directory: use letters, digits, dot, dash or underscore")
    expect(call("a".repeat(65))).toBe("directory: longer than 64 characters")
    expect(call("")).toBe("directory: must be a non-empty string")
  })
})
