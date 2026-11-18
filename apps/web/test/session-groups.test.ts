import type { SessionInfo } from "@openchat/contracts"
import { describe, expect, it } from "vitest"
import {
  EXPANDED_SESSIONS_STORAGE_KEY,
  groupSessions,
  readExpandedSessions,
  writeExpandedSessions,
} from "../src/chat/session-groups"

function session(id: string, parentID?: string): SessionInfo {
  return {
    id,
    title: id,
    directory: "/workspace",
    created: 1,
    updated: 1,
    parentID,
  }
}

describe("groupSessions", () => {
  it("groups children under their parent and never repeats them at the top", () => {
    const groups = groupSessions([
      session("parent"),
      session("child-a", "parent"),
      session("child-b", "parent"),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0]?.session.id).toBe("parent")
    expect(groups[0]?.children.map((child) => child.id)).toEqual(["child-a", "child-b"])
    expect(groups[0]?.orphan).toBe(false)
  })

  it("keeps a child whose parent is missing at the top and marks it", () => {
    const groups = groupSessions([session("orphan", "ses_missing")])

    expect(groups).toHaveLength(1)
    expect(groups[0]?.session.id).toBe("orphan")
    expect(groups[0]?.children).toEqual([])
    expect(groups[0]?.orphan).toBe(true)
  })

  it("attaches a deeper descendant to the visible ancestor instead of dropping it", () => {
    const groups = groupSessions([
      session("root"),
      session("child", "root"),
      session("grandchild", "child"),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0]?.children.map((entry) => entry.id)).toEqual(["child", "grandchild"])
  })
})

describe("expanded sessions storage", () => {
  it("round-trips the expanded ids and treats malformed storage as collapsed", () => {
    expect([...readExpandedSessions()]).toEqual([])

    writeExpandedSessions(new Set(["ses_b", "ses_a"]))
    expect(window.localStorage.getItem(EXPANDED_SESSIONS_STORAGE_KEY)).toBe(
      JSON.stringify(["ses_a", "ses_b"]),
    )
    expect([...readExpandedSessions()].sort()).toEqual(["ses_a", "ses_b"])

    window.localStorage.setItem(EXPANDED_SESSIONS_STORAGE_KEY, "{")
    expect([...readExpandedSessions()]).toEqual([])
    window.localStorage.setItem(EXPANDED_SESSIONS_STORAGE_KEY, JSON.stringify([1, "ses_ok"]))
    expect([...readExpandedSessions()]).toEqual(["ses_ok"])
  })
})
