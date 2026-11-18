import { describe, expect, it, vi } from "vitest"
import type { BackgroundJob, Schedule } from "@openchat/contracts"
import type { JobInfo, OpenCodeClient, ScheduleInfo } from "@opencode/client"
import { BackendError, FakeBackend } from "../src"
import { LiveBackend } from "../src/live"
import { mapScheduleError, normalizeJob, normalizeSchedule } from "../src/live-tasks"

const WORKSPACE = "/workspace"

const HOST_SCHEDULE = {
  id: "sch_host",
  sessionID: "ses_one",
  name: " Weekly summary ",
  when: { type: "every", every: "1 day" },
  tz: "UTC",
  action: { type: "prompt", prompt: "Summarise the week" },
  status: "paused",
  nextDueAt: 5_000,
  endsAt: 9_000,
  runCount: 2,
  lastFiredAt: 4_000,
  lastOutcome: "failed",
  lastOutput: "provider said no",
  time: { created: 1_000, updated: 3_000 },
}

const HOST_JOBS = [
  {
    kind: "subagent",
    id: "job_child",
    sessionID: "ses_one",
    status: "completed",
    time: { started: 1_000, completed: 2_000 },
    childSessionID: "ses_child",
    agent: "build",
    description: "Review the diff",
  },
  {
    kind: "shell",
    id: "job_shell",
    sessionID: "ses_one",
    status: "running",
    time: { started: 500 },
    shellID: "sh_1",
    command: "pnpm test",
  },
  {
    kind: "image",
    id: "job_image",
    sessionID: "ses_one",
    status: "error",
    time: { started: 300, completed: 400 },
    path: "/workspace/out.png",
    model: "image/model",
  },
]

interface StubOptions {
  failTag?: string
}

function stubClient(options: StubOptions = {}) {
  const fail = () => {
    if (!options.failTag) return
    const error = new Error("secret upstream detail") as Error & { _tag: string }
    error._tag = options.failTag
    throw error
  }
  const create = vi.fn(async () => {
    fail()
    return HOST_SCHEDULE
  })
  const list = vi.fn(async () => {
    fail()
    return [HOST_SCHEDULE]
  })
  const pause = vi.fn(async () => {
    fail()
    return { ...HOST_SCHEDULE, status: "paused" }
  })
  const resume = vi.fn(async () => {
    fail()
    return { ...HOST_SCHEDULE, status: "active" }
  })
  const remove = vi.fn(async () => {
    fail()
  })
  const jobs = vi.fn(async () => {
    fail()
    return HOST_JOBS
  })
  const client = {
    experimental: {
      schedule: { create, list, pause, resume, delete: remove },
      job: { list: jobs },
    },
  } as unknown as OpenCodeClient
  return { client, create, list, pause, resume, remove, jobs }
}

function backendWith(client: OpenCodeClient): LiveBackend {
  return new LiveBackend({ baseUrl: "http://unused", password: "unused", workspace: WORKSPACE, client })
}

describe("live schedule mapping", () => {
  it("maps the host schedule onto the stable contract fields", () => {
    const row = normalizeSchedule(HOST_SCHEDULE as unknown as ScheduleInfo)
    const expected: Schedule = {
      id: "sch_host",
      sessionID: "ses_one",
      title: "Weekly summary",
      prompt: "Summarise the week",
      status: "paused",
      nextRunAt: 5_000,
      endsAt: 9_000,
      runCount: 2,
      lastRunAt: 4_000,
      lastOutcome: "failed",
      lastError: "provider said no",
      created: 1_000,
      updated: 3_000,
    }
    expect(row).toEqual(expected)
  })

  it("keeps a prompt excerpt when the host left the schedule unnamed", () => {
    const row = normalizeSchedule({ ...HOST_SCHEDULE, name: undefined } as unknown as ScheduleInfo)
    expect(row.title).toBe("Summarise the week")
  })

  it("lists by session and maps every row", async () => {
    const { client, list } = stubClient()
    const rows = await backendWith(client).listSchedules("ses_one")
    expect(list).toHaveBeenCalledWith({ sessionID: "ses_one" })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe("paused")
  })

  it("maps the end condition to a one-shot host when", async () => {
    const { client, create } = stubClient()
    const backend = backendWith(client)
    await backend.createSchedule({
      sessionID: "ses_one",
      prompt: "Run once",
      ends: { after: "30 minutes" },
    })
    expect(create).toHaveBeenCalledWith({
      sessionID: "ses_one",
      prompt: "Run once",
      when: { type: "in", in: "30 minutes" },
    })
    await backend.createSchedule({
      sessionID: "ses_one",
      prompt: "Run once",
      ends: { at: "2026-11-20T09:30" },
    })
    expect(create).toHaveBeenLastCalledWith({
      sessionID: "ses_one",
      prompt: "Run once",
      when: { type: "at", at: "2026-11-20T09:30" },
    })
  })

  it("targets pause, resume and delete by schedule id", async () => {
    const { client, pause, resume, remove } = stubClient()
    const backend = backendWith(client)
    expect((await backend.pauseSchedule("sch_host")).status).toBe("paused")
    expect((await backend.resumeSchedule("sch_host")).status).toBe("active")
    await backend.deleteSchedule("sch_host")
    expect(pause).toHaveBeenCalledWith({ scheduleID: "sch_host" })
    expect(resume).toHaveBeenCalledWith({ scheduleID: "sch_host" })
    expect(remove).toHaveBeenCalledWith({ scheduleID: "sch_host" })
  })

  it("maps host jobs without forwarding kind-specific fields", () => {
    const rows = HOST_JOBS.map((job) => normalizeJob(job as unknown as JobInfo))
    expect(rows.map((job) => job.kind)).toEqual(["subagent", "shell", "image"])
    expect(rows.map((job) => job.status)).toEqual(["completed", "running", "error"])
    expect(rows[1]?.title).toBe("pnpm test")
    expect(rows[2]?.finished).toBe(400)
    expect(JSON.stringify(rows)).not.toContain("childSessionID")
    expect(JSON.stringify(rows)).not.toContain("/workspace/out.png")
  })

  it("reads the flat job list", async () => {
    const { client, jobs } = stubClient()
    const rows = await backendWith(client).listJobs()
    expect(jobs).toHaveBeenCalledWith()
    expect(rows).toHaveLength(3)
  })
})

describe("live schedule errors", () => {
  it("maps structured tags to stable codes without leaking text", () => {
    const notFound = mapScheduleError({ _tag: "ScheduleNotFoundError" }, "Unknown schedule")
    expect(notFound.code).toBe("not_found")
    expect(notFound.message).not.toContain("secret")

    const invalid = mapScheduleError({ _tag: "InvalidRequestError" }, "Bad schedule")
    expect(invalid.code).toBe("invalid")

    const unavailable = mapScheduleError(new Error("secret upstream detail"), "Host failed")
    expect(unavailable.code).toBe("unavailable")
    expect(unavailable.message).not.toContain("secret")
  })

  it("turns a missing host schedule into a not_found backend error", async () => {
    const { client } = stubClient({ failTag: "ScheduleNotFoundError" })
    const failure = await backendWith(client).pauseSchedule("sch_host").catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(BackendError)
    expect((failure as BackendError).code).toBe("not_found")
  })
})

describe("fake task store", () => {
  const makeBackend = (seedJobs: readonly BackgroundJob[] = []) =>
    new FakeBackend({ delayMs: 0, now: () => 1_000, seedJobs })

  it("creates, lists, pauses, resumes and deletes against the injected clock", async () => {
    const backend = makeBackend()
    await backend.createSession({ title: "Notes", directory: WORKSPACE })

    const created = await backend.createSchedule({
      sessionID: "ses_1",
      prompt: "Summarise the notes",
      ends: { after: "15 minutes" },
    })
    expect(created).toMatchObject({
      id: "sch_1",
      status: "active",
      runCount: 0,
      created: 1_000,
      nextRunAt: 1_000 + 15 * 60_000,
    })
    expect((await backend.listSchedules("ses_1"))[0]).toEqual(created)

    expect((await backend.pauseSchedule("sch_1")).status).toBe("paused")
    expect((await backend.listSchedules("ses_1"))[0]?.status).toBe("paused")
    expect((await backend.resumeSchedule("sch_1")).status).toBe("active")
    await backend.deleteSchedule("sch_1")
    expect(await backend.listSchedules("ses_1")).toEqual([])
  })

  it("keeps schedules of different sessions separate", async () => {
    const backend = makeBackend()
    await backend.createSession({ title: "A", directory: WORKSPACE })
    await backend.createSession({ title: "B", directory: WORKSPACE })
    await backend.createSchedule({ sessionID: "ses_1", prompt: "one", ends: { after: "5 minutes" } })
    await backend.createSchedule({ sessionID: "ses_2", prompt: "two", ends: { after: "5 minutes" } })
    expect((await backend.listSchedules("ses_1")).map((row) => row.prompt)).toEqual(["one"])
  })

  it("refuses an unknown session and an unknown id", async () => {
    const backend = makeBackend()
    const noSession = await backend
      .createSchedule({ sessionID: "ses_missing", prompt: "x", ends: { after: "5 minutes" } })
      .catch((error: unknown) => error)
    expect((noSession as BackendError).code).toBe("not_found")

    for (const action of [
      () => backend.pauseSchedule("sch_missing"),
      () => backend.resumeSchedule("sch_missing"),
      () => backend.deleteSchedule("sch_missing"),
    ]) {
      const failure = await action().catch((error: unknown) => error)
      expect((failure as BackendError).code).toBe("not_found")
    }
  })

  it("lists seeded jobs with running ones first", async () => {
    const backend = makeBackend(HOST_JOBS.map((job) => normalizeJob(job as unknown as JobInfo)))
    const jobs = await backend.listJobs()
    expect(jobs.map((job) => job.status)).toEqual(["running", "completed", "error"])
    // The store returns copies, so a caller cannot mutate its fixture.
    const first = jobs[0]
    if (first) first.status = "cancelled"
    expect((await backend.listJobs())[0]?.status).toBe("running")
  })
})
