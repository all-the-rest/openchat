import type { BackgroundJob, Schedule, ScheduleEnds } from "@openchat/contracts"
import { scheduleEndsMillis } from "@openchat/contracts"
import { BackendError } from "./errors"
import type { CreateScheduleInput } from "./index"

/** A schedule plus the end condition the fake was created with. */
interface StoredSchedule extends Schedule {
  ends: ScheduleEnds
}

export interface FakeTaskStoreOptions {
  /** Injected clock, shared with the rest of the fake backend. */
  now?: () => number
  /** Deterministic job rows for offline pages and tests. */
  jobs?: readonly BackgroundJob[]
}

/**
 * In-memory task store for the fake backend. Nothing here reaches the host: a
 * created schedule is a one-shot row whose fire time comes from its end
 * condition, and pause/resume/delete mutate that row in place.
 */
export class FakeTaskStore {
  private readonly schedules = new Map<string, StoredSchedule>()
  private readonly jobs: BackgroundJob[]
  private readonly taskClock: () => number
  private sequence = 0

  constructor(options: FakeTaskStoreOptions = {}) {
    this.taskClock = options.now ?? (() => Date.now())
    this.jobs = (options.jobs ?? []).map((job) => ({ ...job }))
  }

  /** The fake backend overrides this with its session list. */
  protected requireSession(_sessionID: string): void {}

  async listSchedules(sessionID: string): Promise<Schedule[]> {
    this.requireSession(sessionID)
    return [...this.schedules.values()]
      .filter((schedule) => schedule.sessionID === sessionID)
      .sort((left, right) => left.created - right.created)
      .map((schedule) => this.public(schedule))
  }

  async createSchedule(input: CreateScheduleInput): Promise<Schedule> {
    this.requireSession(input.sessionID)
    const now = this.taskClock()
    const fireAt = scheduleEndsMillis(input.ends, now)
    const prompt = input.prompt.trim()
    const id = `sch_${(this.sequence += 1)}`
    const stored: StoredSchedule = {
      id,
      sessionID: input.sessionID,
      title: prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt,
      prompt,
      status: "active",
      runCount: 0,
      created: now,
      updated: now,
      ends: input.ends,
      ...(fireAt === undefined ? {} : { nextRunAt: fireAt, endsAt: fireAt }),
    }
    this.schedules.set(id, stored)
    return this.public(stored)
  }

  async pauseSchedule(id: string): Promise<Schedule> {
    const stored = this.require(id)
    if (stored.status === "done") {
      throw new BackendError("conflict", `Schedule ${id} has already finished`)
    }
    stored.status = "paused"
    stored.updated = this.taskClock()
    return this.public(stored)
  }

  async resumeSchedule(id: string): Promise<Schedule> {
    const stored = this.require(id)
    if (stored.status !== "paused") {
      throw new BackendError("conflict", `Schedule ${id} is not paused`)
    }
    stored.status = "active"
    stored.updated = this.taskClock()
    return this.public(stored)
  }

  async deleteSchedule(id: string): Promise<void> {
    this.require(id)
    this.schedules.delete(id)
  }

  async listJobs(): Promise<BackgroundJob[]> {
    // Running jobs first, then newest first; ties keep insertion order.
    return [...this.jobs]
      .sort((left, right) => {
        const leftRunning = left.status === "running" ? 1 : 0
        const rightRunning = right.status === "running" ? 1 : 0
        return rightRunning - leftRunning || right.started - left.started
      })
      .map((job) => ({ ...job }))
  }

  private require(id: string): StoredSchedule {
    const stored = this.schedules.get(id)
    if (!stored) throw new BackendError("not_found", `Unknown schedule: ${id}`)
    return stored
  }

  /** The host's end condition is an implementation detail of the fake. */
  private public(stored: StoredSchedule): Schedule {
    const { ends: _ends, ...visible } = stored
    return { ...visible }
  }
}
