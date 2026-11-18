import { z } from "zod"

/**
 * Scheduled work and background jobs.
 *
 * These are the stable fields the UI needs, normalized from the host's
 * `experimental.schedule.*` and `experimental.job.list` responses. Host-only
 * fields (conditions, time zone, raw output) stay in the adapter.
 */

/** Mirrors the host schedule status union. */
export type ScheduleStatus = "active" | "done" | "paused"

/**
 * One server-side schedule. It runs on the host even when no browser is open.
 * `title` is the host name or, when absent, a short excerpt of `prompt`.
 */
export interface Schedule {
  id: string
  sessionID: string
  title: string
  prompt: string
  status: ScheduleStatus
  /** Epoch ms of the next fire, when the host reports one. */
  nextRunAt?: number
  /** Epoch ms at which the schedule stops, when the host reports one. */
  endsAt?: number
  runCount: number
  /** Epoch ms of the last fire, when the host reports one. */
  lastRunAt?: number
  /** Host outcome of the last fire, e.g. `fired` or `failed`. */
  lastOutcome?: string
  /** Bounded host error text of a failed run; diagnostics only. */
  lastError?: string
  created: number
  updated: number
}

export type BackgroundJobKind = "shell" | "subagent" | "image"
export type BackgroundJobStatus = "running" | "completed" | "error" | "cancelled"

/**
 * A long-running shell command, subagent or image job. Jobs are listed flat:
 * there is no parent/child session tree in the pinned host API.
 */
export interface BackgroundJob {
  id: string
  sessionID: string
  kind: BackgroundJobKind
  status: BackgroundJobStatus
  title?: string
  /** Epoch ms from the host's `time.started`. */
  started: number
  /** Epoch ms from the host's `time.completed`, when the job has finished. */
  finished?: number
}

/** Duration accepted by the v1 "end condition" form, e.g. `15 minutes`. */
const AFTER_PATTERN = /^(\d+)\s+(second|minute|hour|day|week)s?$/i

/** Upper bound of a v1 one-shot delay, expressed per unit. */
const AFTER_CAPS: Record<string, number> = {
  second: 90 * 24 * 60 * 60,
  minute: 90 * 24 * 60,
  hour: 90 * 24,
  day: 90,
  week: 12,
}

const AFTER_MILLIS: Record<string, number> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
}

/** `datetime-local` input (`2026-11-18T09:30`) or an ISO instant with offset. */
const AT_PATTERN = /^(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/

export const scheduleEndsSchema = z
  .object({
    after: z.string().trim().min(1).max(32).optional(),
    at: z.string().trim().min(1).max(32).optional(),
  })
  .refine((value) => (value.after === undefined) !== (value.at === undefined), {
    message: "Provide exactly one of after or at",
  })
  .refine(
    (value) => {
      if (value.after === undefined) return true
      const match = AFTER_PATTERN.exec(value.after)
      const unit = match?.[2]
      if (!unit) return false
      const amount = Number(match[1])
      const cap = AFTER_CAPS[unit.toLowerCase()]
      return cap !== undefined && amount >= 1 && amount <= cap
    },
    { message: "after must be a duration of at least one unit and at most 90 days" },
  )
  .refine(
    (value) => {
      if (value.at === undefined) return true
      const match = AT_PATTERN.exec(value.at)
      if (!match || !Number.isFinite(Date.parse(value.at))) return false
      const year = Number(match[1])
      return year >= 2000 && year <= 2100
    },
    { message: "at must be a valid date and time between 2000 and 2100" },
  )

export const createScheduleRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  ends: scheduleEndsSchema,
})

export type ScheduleEnds = z.infer<typeof scheduleEndsSchema>
export type CreateScheduleRequest = z.infer<typeof createScheduleRequestSchema>

/**
 * Epoch ms of a validated one-shot end condition. `after` resolves against
 * `now`; `at` is already an instant (or a wall-clock time parsed locally).
 */
export function scheduleEndsMillis(ends: ScheduleEnds, now: number): number | undefined {
  if (ends.at !== undefined) {
    const parsed = Date.parse(ends.at)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (ends.after === undefined) return undefined
  const match = AFTER_PATTERN.exec(ends.after)
  const unit = match?.[2]
  if (!unit) return undefined
  const multiplier = AFTER_MILLIS[unit.toLowerCase()]
  if (multiplier === undefined) return undefined
  return now + Number(match[1]) * multiplier
}
