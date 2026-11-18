import { useState } from "react"
import type { Schedule, ScheduleStatus, SessionInfo } from "@openchat/contracts"
import { Link } from "react-router-dom"
import { api } from "../api/client"
import { ErrorBanner } from "../components/ErrorBanner"
import type { MessageKey } from "../i18n"
import { useI18n, useT } from "../i18n/provider"
import { formatWhen } from "./format"

const STATUS_KEYS: Record<ScheduleStatus, MessageKey> = {
  active: "tasks.status.active",
  paused: "tasks.status.paused",
  done: "tasks.status.done",
}

type EndMode = "after" | "at"

interface ScheduleListProps {
  sessions: readonly SessionInfo[]
  schedules: readonly Schedule[]
  /** Re-read schedules and jobs after a mutation. */
  onChanged: () => Promise<void>
}

export function ScheduleList({ sessions, schedules, onChanged }: ScheduleListProps) {
  const t = useT()
  const { locale } = useI18n()
  const [sessionID, setSessionID] = useState(() => sessions[0]?.id ?? "")
  const [prompt, setPrompt] = useState("")
  const [mode, setMode] = useState<EndMode>("after")
  const [duration, setDuration] = useState("30 minutes")
  const [at, setAt] = useState("")
  const [creating, setCreating] = useState(false)
  const [busyID, setBusyID] = useState<string | null>(null)
  const [confirmID, setConfirmID] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // A session removed between loads must not stay selected.
  const selected = sessions.some((session) => session.id === sessionID)
    ? sessionID
    : (sessions[0]?.id ?? "")

  const changeSchedule = async (action: "pause" | "resume" | "delete", schedule: Schedule) => {
    if (busyID !== null) return
    setBusyID(schedule.id)
    setBanner(null)
    setNotice(null)
    try {
      if (action === "pause") await api.pauseSchedule(schedule.id)
      else if (action === "resume") await api.resumeSchedule(schedule.id)
      else await api.deleteSchedule(schedule.id)
      setConfirmID(null)
      await onChanged()
    } catch {
      setBanner(t("tasks.action.failed"))
    } finally {
      setBusyID(null)
    }
  }

  const submit = async () => {
    if (creating || selected.length === 0 || prompt.trim().length === 0) return
    setCreating(true)
    setBanner(null)
    setNotice(null)
    try {
      await api.createSchedule(selected, {
        prompt: prompt.trim(),
        ends: mode === "after" ? { after: duration.trim() } : { at },
      })
      setPrompt("")
      setNotice(t("tasks.create.created"))
      await onChanged()
    } catch {
      setBanner(t("tasks.create.failed"))
    } finally {
      setCreating(false)
    }
  }

  return (
    <section aria-labelledby="tasks-schedules-heading" data-testid="tasks-schedules">
      <h2 id="tasks-schedules-heading" className="text-base font-semibold">
        {t("tasks.schedules")}
      </h2>

      {banner ? <div className="mt-2"><ErrorBanner message={banner} onDismiss={() => setBanner(null)} /></div> : null}
      {notice ? (
        <p role="status" aria-live="polite" data-testid="tasks-create-notice" className="mt-2 text-sm text-muted">
          {notice}
        </p>
      ) : null}

      {schedules.length === 0 ? (
        <p data-testid="tasks-schedules-empty" className="mt-2 text-sm text-muted">
          {t("tasks.schedules.empty")}
        </p>
      ) : (
        <ul data-testid="tasks-schedule-list" className="mt-2 flex flex-col gap-2">
          {schedules.map((schedule) => {
            const nextRun = formatWhen(schedule.nextRunAt, locale)
            const endsAt = formatWhen(schedule.endsAt, locale)
            const lastRun = formatWhen(schedule.lastRunAt, locale)
            const confirming = confirmID === schedule.id
            return (
              <li
                key={schedule.id}
                data-testid="tasks-schedule"
                className="rounded-card border border-subtle bg-surface p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{schedule.title}</span>
                  <span data-testid="tasks-schedule-status" className="badge badge-sm">
                    {t(STATUS_KEYS[schedule.status])}
                  </span>
                </div>
                <p data-testid="tasks-schedule-prompt" className="mt-1 text-sm text-secondary">
                  {t("tasks.schedules.prompt", { text: schedule.prompt })}
                </p>
                <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-muted">
                  {schedule.status === "active" && nextRun ? (
                    <span>{t("tasks.schedules.nextRun", { when: nextRun })}</span>
                  ) : null}
                  {endsAt ? <span>{t("tasks.schedules.endsAt", { when: endsAt })}</span> : null}
                  <span>{t("tasks.schedules.runs", { count: schedule.runCount })}</span>
                  {lastRun ? <span>{t("tasks.schedules.lastRun", { when: lastRun })}</span> : null}
                  {schedule.lastError ? (
                    <span className="text-error">
                      {t("tasks.schedules.error", { text: schedule.lastError })}
                    </span>
                  ) : null}
                </div>
                {schedule.sessionID ? (
                  <Link
                    to={`/c/${schedule.sessionID}`}
                    data-testid="tasks-schedule-session"
                    className="mt-1 inline-block text-sm link link-hover"
                  >
                    {t("tasks.schedules.session", { title: schedule.sessionID })}
                  </Link>
                ) : (
                  <span className="mt-1 block text-xs text-muted">
                    {t("tasks.schedules.noSession")}
                  </span>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  {schedule.status === "paused" ? (
                    <button
                      type="button"
                      data-testid="tasks-resume"
                      disabled={busyID !== null}
                      onClick={() => void changeSchedule("resume", schedule)}
                      className="btn btn-ghost btn-xs"
                    >
                      {t("tasks.action.resume", { title: schedule.title })}
                    </button>
                  ) : (
                    <button
                      type="button"
                      data-testid="tasks-pause"
                      disabled={busyID !== null || schedule.status === "done"}
                      onClick={() => void changeSchedule("pause", schedule)}
                      className="btn btn-ghost btn-xs"
                    >
                      {t("tasks.action.pause", { title: schedule.title })}
                    </button>
                  )}
                  {confirming ? (
                    <>
                      <button
                        type="button"
                        data-testid="tasks-delete-confirm"
                        disabled={busyID !== null}
                        onClick={() => void changeSchedule("delete", schedule)}
                        className="btn btn-error btn-xs"
                      >
                        {t("tasks.action.confirm", { title: schedule.title })}
                      </button>
                      <button
                        type="button"
                        data-testid="tasks-delete-cancel"
                        onClick={() => setConfirmID(null)}
                        className="btn btn-ghost btn-xs"
                      >
                        {t("tasks.action.cancel")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      data-testid="tasks-delete"
                      disabled={busyID !== null}
                      onClick={() => setConfirmID(schedule.id)}
                      className="btn btn-ghost btn-xs"
                    >
                      {t("tasks.action.delete", { title: schedule.title })}
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <form
        data-testid="tasks-create-form"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
        className="mt-4 flex flex-col gap-2 rounded-card border border-subtle bg-surface p-3"
      >
        <h3 className="text-sm font-semibold">{t("tasks.create.title")}</h3>
        {sessions.length === 0 ? (
          <p className="text-sm text-muted">{t("tasks.create.noSessions")}</p>
        ) : null}
        <label className="flex flex-col gap-1 text-sm">
          {t("tasks.create.session")}
          <select
            data-testid="tasks-create-session"
            value={selected}
            onChange={(event) => setSessionID(event.target.value)}
            className="select select-sm"
          >
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title || session.id}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted">{t("tasks.create.sessionHint")}</span>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t("tasks.create.prompt")}
          <textarea
            data-testid="tasks-create-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={3}
            maxLength={4000}
            className="textarea textarea-sm"
          />
          <span className="text-xs text-muted">{t("tasks.create.promptHint")}</span>
        </label>
        <fieldset className="flex flex-col gap-1 text-sm">
          <legend>{t("tasks.create.ends")}</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="tasks-ends"
              data-testid="tasks-create-mode-after"
              checked={mode === "after"}
              onChange={() => setMode("after")}
            />
            {t("tasks.create.after")}
          </label>
          {mode === "after" ? (
            <input
              data-testid="tasks-create-duration"
              value={duration}
              onChange={(event) => setDuration(event.target.value)}
              maxLength={32}
              placeholder={t("tasks.create.duration")}
              className="input input-sm"
            />
          ) : null}
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="tasks-ends"
              data-testid="tasks-create-mode-at"
              checked={mode === "at"}
              onChange={() => setMode("at")}
            />
            {t("tasks.create.at")}
          </label>
          {mode === "at" ? (
            <input
              type="datetime-local"
              data-testid="tasks-create-datetime"
              value={at}
              onChange={(event) => setAt(event.target.value)}
              className="input input-sm"
            />
          ) : null}
        </fieldset>
        <button
          type="submit"
          data-testid="tasks-create-submit"
          disabled={creating || selected.length === 0 || prompt.trim().length === 0}
          className="btn btn-primary btn-sm self-start"
        >
          {t("tasks.create.submit")}
        </button>
      </form>
    </section>
  )
}
