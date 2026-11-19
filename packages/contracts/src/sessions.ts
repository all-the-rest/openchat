import { z } from "zod"

import type { TokenUsage } from "./compaction"

/**
 * Token counts the host reported for one chat. Only fields the host actually
 * sent are present; the UI must show "not reported" rather than a zero it
 * invented. `cached` is the provider's cache read, which some hosts omit.
 */
export interface UsageReport {
  input: number
  output: number
  cached?: number
}

export interface SessionInfo {
  id: string
  title: string
  directory: string
  created: number
  updated: number
  /** Parent chat of a subagent session; absent for a normal chat. */
  parentID?: string
  /**
   * Chat this session was branched from. A fork is not a subagent chat, so it
   * carries this instead of `parentID`; the UI links back to it explicitly.
   */
  branchOf?: string
  /** Message the branch was forked before; present together with `branchOf`. */
  branchBefore?: string
  /** Absent until the host reports a run; zero-token reports are omitted. */
  usage?: TokenUsage
}

export const forkSessionRequestSchema = z.object({
  /** User message the new branch ends before. */
  messageID: z.string().min(1).max(200),
})

export const renameSessionRequestSchema = z.object({
  /** Trimmed by the route; the host stores the title as given. */
  title: z.string().trim().min(1).max(120),
})
