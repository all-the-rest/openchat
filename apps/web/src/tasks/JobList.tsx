import type { BackgroundJob, BackgroundJobKind, BackgroundJobStatus } from "@openchat/contracts"
import { Link } from "react-router-dom"
import type { MessageKey } from "../i18n"
import { useI18n, useT } from "../i18n/provider"
import { formatWhen } from "./format"

const KIND_KEYS: Record<BackgroundJobKind, MessageKey> = {
  shell: "tasks.kind.shell",
  subagent: "tasks.kind.subagent",
  image: "tasks.kind.image",
}

const STATUS_KEYS: Record<BackgroundJobStatus, MessageKey> = {
  running: "tasks.status.running",
  completed: "tasks.status.completed",
  error: "tasks.status.error",
  cancelled: "tasks.status.cancelled",
}

/** Running jobs first, then newest; never mutate the caller's array. */
export function orderJobs(jobs: readonly BackgroundJob[]): BackgroundJob[] {
  const running = (job: BackgroundJob) => (job.status === "running" ? 1 : 0)
  return [...jobs].sort((left, right) => running(right) - running(left) || right.started - left.started)
}

export function JobList({ jobs }: { jobs: readonly BackgroundJob[] }) {
  const t = useT()
  const { locale } = useI18n()

  if (jobs.length === 0) {
    return (
      <p data-testid="tasks-jobs-empty" className="text-sm text-muted">
        {t("tasks.jobs.empty")}
      </p>
    )
  }

  return (
    <ul data-testid="tasks-job-list" className="flex flex-col gap-2">
      {orderJobs(jobs).map((job) => {
        const started = formatWhen(job.started, locale)
        const finished = formatWhen(job.finished, locale)
        return (
          <li
            key={job.id}
            data-testid="tasks-job"
            className="rounded-card border border-subtle bg-surface p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">
                {t("tasks.jobs.kind", {
                  kind: t(KIND_KEYS[job.kind]),
                  title: job.title ?? job.id,
                })}
              </span>
              <span data-testid="tasks-job-status" className="badge badge-sm">
                {t(STATUS_KEYS[job.status])}
              </span>
              {job.sessionID ? (
                <Link
                  to={`/c/${job.sessionID}`}
                  data-testid="tasks-job-session"
                  className="text-sm link link-hover"
                >
                  {t("tasks.schedules.session", { title: job.sessionID })}
                </Link>
              ) : null}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-muted">
              {started ? <span>{t("tasks.jobs.started", { when: started })}</span> : null}
              {finished ? <span>{t("tasks.jobs.finished", { when: finished })}</span> : null}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
