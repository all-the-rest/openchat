import { useCallback, useEffect, useRef, useState } from "react"
import type { BackgroundJob, Schedule, SessionInfo } from "@openchat/contracts"
import { api } from "../api/client"
import { ErrorBanner } from "../components/ErrorBanner"
import { useT } from "../i18n/provider"
import { JobList } from "./JobList"
import { ScheduleList } from "./ScheduleList"

type LoadStatus = "loading" | "ready" | "error"

/**
 * `/tasks` — the task board from spec 06. Schedules are listed per session
 * because the host API requires a session id; jobs are already flat. The page
 * states that schedules run on the server, independent of this browser.
 */
export function TasksPage() {
  const t = useT()
  const [status, setStatus] = useState<LoadStatus>("loading")
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [jobs, setJobs] = useState<BackgroundJob[]>([])
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(async (silent: boolean) => {
    if (!silent) setStatus("loading")
    try {
      const [sessionRows, jobRows] = await Promise.all([api.listSessions(), api.jobs()])
      const grouped = await Promise.all(sessionRows.map((session) => api.listSchedules(session.id)))
      if (!alive.current) return
      setSessions(sessionRows)
      setSchedules(grouped.flat())
      setJobs(jobRows)
      setStatus("ready")
    } catch {
      if (!alive.current) return
      setStatus("error")
    }
  }, [])

  useEffect(() => {
    void load(false)
  }, [load])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold">{t("tasks.title")}</h1>
          <p className="text-sm text-muted">{t("tasks.description")}</p>
        </header>

        <p
          role="note"
          data-testid="tasks-server-note"
          className="rounded-row border border-subtle bg-surface px-3 py-2 text-sm text-secondary"
        >
          {t("tasks.serverNote")}
        </p>

        {status === "loading" ? (
          <div
            role="status"
            aria-live="polite"
            data-testid="tasks-loading"
            className="flex items-center gap-2 text-sm text-muted"
          >
            <span className="loading loading-spinner loading-sm" aria-hidden="true" />
            {t("tasks.loading")}
          </div>
        ) : status === "error" ? (
          <div className="flex flex-col items-start gap-2">
            <ErrorBanner message={t("tasks.loadFailed")} />
            <button type="button" onClick={() => void load(false)} className="btn btn-sm">
              {t("tasks.retry")}
            </button>
          </div>
        ) : (
          <>
            <ScheduleList
              sessions={sessions}
              schedules={schedules}
              onChanged={() => load(true)}
            />
            <section aria-labelledby="tasks-jobs-heading" data-testid="tasks-jobs">
              <h2 id="tasks-jobs-heading" className="text-base font-semibold">
                {t("tasks.jobs")}
              </h2>
              <div className="mt-2">
                <JobList jobs={jobs} />
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  )
}
