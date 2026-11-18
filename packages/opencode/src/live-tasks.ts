import type {
  BackgroundJob,
  BackgroundJobKind,
  BackgroundJobStatus,
  Schedule,
  ScheduleEnds,
  ScheduleStatus,
} from "@openchat/contracts"
import type { JobInfo, ScheduleInfo } from "@opencode/client"
import { BackendError } from "./errors"

/** Host rows are untrusted JSON: every normalized field is checked. */
const SCHEDULE_STATUSES: readonly ScheduleStatus[] = ["active", "done", "paused"]
const JOB_KINDS: readonly BackgroundJobKind[] = ["shell", "subagent", "image"]
const JOB_STATUSES: readonly BackgroundJobStatus[] = ["running", "completed", "error", "cancelled"]

const MAX_TITLE = 120
const MAX_ERROR = 300
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]+/g

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined
  const clean = value.replace(UNSAFE_CHARACTERS, " ").replace(/\s+/g, " ").trim()
  if (clean.length === 0) return undefined
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

function epoch(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined
}

/** The host report is authoritative; an unknown status is treated as active. */
function scheduleStatus(value: unknown): ScheduleStatus {
  return oneOf(value, SCHEDULE_STATUSES) ?? "active"
}

/** A one-shot delay or instant, derived from the validated form's end condition. */
export function scheduleWhen(
  ends: ScheduleEnds,
): { type: "in"; in: string } | { type: "at"; at: string } {
  if (ends.after !== undefined) return { type: "in", in: ends.after }
  if (ends.at !== undefined) return { type: "at", at: ends.at }
  throw new BackendError("invalid", "A schedule needs an end condition")
}

export function normalizeSchedule(info: ScheduleInfo): Schedule {
  const name = text(info.name, MAX_TITLE)
  const prompt = text(info.action?.prompt, 4000) ?? ""
  const status = scheduleStatus(info.status)
  const lastOutcome = text(info.lastOutcome, 40)
  const schedule: Schedule = {
    id: info.id,
    sessionID: info.sessionID ?? "",
    title: name ?? (prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt),
    prompt,
    status,
    runCount: epoch(info.runCount) ?? 0,
    created: epoch(info.time?.created) ?? 0,
    updated: epoch(info.time?.updated) ?? 0,
  }
  const nextRunAt = epoch(info.nextDueAt)
  if (nextRunAt !== undefined) schedule.nextRunAt = nextRunAt
  const endsAt = epoch(info.endsAt)
  if (endsAt !== undefined) schedule.endsAt = endsAt
  const lastRunAt = epoch(info.lastFiredAt)
  if (lastRunAt !== undefined) schedule.lastRunAt = lastRunAt
  if (lastOutcome !== undefined) schedule.lastOutcome = lastOutcome
  // Only a failed run carries error text; other outcomes never show one.
  if (lastOutcome === "failed") {
    const error = text(info.lastOutput, MAX_ERROR)
    if (error !== undefined) schedule.lastError = error
  }
  return schedule
}

/** A short label for a job that has no explicit host title. */
function jobTitle(info: JobInfo): string | undefined {
  const explicit = text(info.title, MAX_TITLE)
  if (explicit) return explicit
  if (info.kind === "subagent") {
    return text(info.description, MAX_TITLE) ?? text(info.agent, MAX_TITLE)
  }
  if (info.kind === "shell") return text(info.command, MAX_TITLE)
  return text(info.model, MAX_TITLE)
}

export function normalizeJob(info: JobInfo): BackgroundJob {
  const title = jobTitle(info)
  const job: BackgroundJob = {
    id: info.id,
    sessionID: info.sessionID ?? "",
    kind: oneOf(info.kind, JOB_KINDS) ?? "shell",
    status: oneOf(info.status, JOB_STATUSES) ?? "running",
    started: epoch(info.time?.started) ?? 0,
  }
  if (title !== undefined) job.title = title
  const finished = epoch(info.time?.completed)
  if (finished !== undefined) job.finished = finished
  return job
}

interface TaggedError {
  _tag?: unknown
}

function errorTag(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const tag = (error as TaggedError)._tag
  return typeof tag === "string" ? tag : undefined
}

/**
 * Maps a host rejection to a stable backend code by its structured `_tag`.
 * The upstream message is never forwarded: it may carry tokens or paths.
 */
export function mapScheduleError(error: unknown, fallback: string): BackendError {
  const tag = errorTag(error)
  if (tag === "ScheduleNotFoundError" || tag === "SessionNotFoundError") {
    return new BackendError("not_found", fallback)
  }
  if (tag === "InvalidRequestError") return new BackendError("invalid", fallback)
  return new BackendError("unavailable", fallback)
}
