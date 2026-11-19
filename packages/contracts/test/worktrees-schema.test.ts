import { describe, expect, it } from "vitest"
import {
  createWorktreeRequestSchema,
  removeWorktreeQuerySchema,
  WORKTREE_DIRTY_CODE,
} from "../src/worktrees"

describe("create worktree request", () => {
  it("accepts a branch alone and with a base and a name", () => {
    expect(createWorktreeRequestSchema.safeParse({ branch: "feat/worktrees" }).success).toBe(true)
    expect(
      createWorktreeRequestSchema.parse({
        branch: " feat/worktrees ",
        from: "main",
        name: "Worktrees",
      }),
    ).toEqual({ branch: "feat/worktrees", from: "main", name: "Worktrees" })
  })

  it.each([
    ["missing branch", {}],
    ["empty branch", { branch: "  " }],
    ["branch with a space", { branch: "feat worktrees" }],
    ["branch with a colon", { branch: "feat:worktrees" }],
    ["branch with ..", { branch: "feat/../main" }],
    ["branch with a leading slash", { branch: "/feat" }],
    ["branch with a trailing slash", { branch: "feat/" }],
    ["overlong branch", { branch: `feat/${"x".repeat(200)}` }],
    ["overlong name", { branch: "feat/x", name: "x".repeat(121) }],
    ["empty from", { branch: "feat/x", from: " " }],
  ])("rejects %s", (_label, body) => {
    expect(createWorktreeRequestSchema.safeParse(body).success).toBe(false)
  })
})

describe("remove worktree query", () => {
  it("accepts a directory with, without and without a force flag", () => {
    expect(removeWorktreeQuerySchema.parse({ directory: "/workspace/.worktrees/x" })).toEqual({
      directory: "/workspace/.worktrees/x",
    })
    expect(
      removeWorktreeQuerySchema.parse({ directory: "/w/x", force: "true" }),
    ).toEqual({ directory: "/w/x", force: "true" })
    expect(
      removeWorktreeQuerySchema.parse({ directory: "/w/x", force: "false" }),
    ).toEqual({ directory: "/w/x", force: "false" })
  })

  it.each([
    ["missing directory", {}],
    ["empty directory", { directory: "  " }],
    ["ambiguous force", { directory: "/w/x", force: "1" }],
    ["uppercase force", { directory: "/w/x", force: "TRUE" }],
  ])("rejects %s", (_label, query) => {
    expect(removeWorktreeQuerySchema.safeParse(query).success).toBe(false)
  })

  it("keeps the dirty code distinct from the generic conflict code", () => {
    expect(WORKTREE_DIRTY_CODE).toBe("worktree_dirty")
  })
})
