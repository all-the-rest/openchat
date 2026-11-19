import { useCallback, useEffect, useRef, useState } from "react"
import type { WorktreeInfo } from "@openchat/contracts"
import { api, ApiError } from "../api/client"
import { ErrorBanner } from "../components/ErrorBanner"
import { useT } from "../i18n/provider"
import { RemoveWorktreeDialog } from "./RemoveWorktreeDialog"
import type { RemoveProblem } from "./RemoveWorktreeDialog"

type LoadStatus = "loading" | "ready" | "error"

/** Only a structured BFF code is meaningful; transport errors stay generic. */
function errorCode(error: unknown): string | undefined {
  return error instanceof ApiError ? error.code : undefined
}

/**
 * `/worktrees` (spec 06, FR-23). The list comes from the BFF, which resolves
 * the host project for this workspace. Creation asks for the branch, an
 * optional base and an optional display name; the page shows the directory the
 * host created. Removal always opens a confirmation that spells out the force
 * case, and a refusal caused by uncommitted changes is shown as such instead
 * of being retried with `force`.
 */
export function WorktreesPage() {
  const t = useT()
  const [status, setStatus] = useState<LoadStatus>("loading")
  const [rows, setRows] = useState<WorktreeInfo[]>([])
  const [projectID, setProjectID] = useState<string | null>(null)
  const [branch, setBranch] = useState("")
  const [from, setFrom] = useState("")
  const [name, setName] = useState("")
  const [creating, setCreating] = useState(false)
  const [createProblem, setCreateProblem] = useState<"failed" | "exists" | "limit" | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [target, setTarget] = useState<WorktreeInfo | null>(null)
  const [removing, setRemoving] = useState(false)
  const [removeProblem, setRemoveProblem] = useState<RemoveProblem | null>(null)
  const alive = useRef(true)
  const headingRef = useRef<HTMLHeadingElement>(null)
  /** The row button that opened the dialog; focus returns there on close. */
  const openerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const read = useCallback(async () => {
    const body = await api.worktrees()
    if (!alive.current) return
    setRows(body.worktrees)
    setProjectID(body.projectID ?? null)
  }, [])

  const load = useCallback(async () => {
    setStatus("loading")
    try {
      await read()
      if (alive.current) setStatus("ready")
    } catch {
      if (alive.current) setStatus("error")
    }
  }, [read])

  useEffect(() => {
    void load()
  }, [load])

  const submit = async () => {
    const ref = branch.trim()
    if (creating || ref.length === 0) return
    setCreating(true)
    setCreateProblem(null)
    setNotice(null)
    try {
      const created = await api.createWorktree({
        branch: ref,
        ...(from.trim().length > 0 ? { from: from.trim() } : {}),
        ...(name.trim().length > 0 ? { name: name.trim() } : {}),
      })
      setBranch("")
      setFrom("")
      setName("")
      setNotice(
        t("worktrees.create.created", {
          directory: created.directory,
          branch: created.branch ?? ref,
        }),
      )
      await read()
    } catch (error) {
      const code = errorCode(error)
      setCreateProblem(
        code === "worktree_exists" ? "exists" : code === "worktree_limit" ? "limit" : "failed",
      )
    } finally {
      if (alive.current) setCreating(false)
    }
  }

  /** Focus returns to the row that opened the dialog, or the heading when it is gone. */
  const finishRemoveFocus = useCallback((preferHeading: boolean) => {
    const opener = openerRef.current
    openerRef.current = null
    if (!preferHeading && opener !== null && opener.isConnected) opener.focus()
    else headingRef.current?.focus()
  }, [])

  const cancelRemove = useCallback(() => {
    if (removing) return
    setTarget(null)
    setRemoveProblem(null)
    finishRemoveFocus(false)
  }, [removing, finishRemoveFocus])

  const openRemove = (worktree: WorktreeInfo, opener: HTMLElement) => {
    openerRef.current = opener
    setTarget(worktree)
    setRemoveProblem(null)
  }

  const remove = async (force: boolean) => {
    if (!target || removing) return
    setRemoving(true)
    setRemoveProblem(null)
    try {
      await api.removeWorktree(target.directory, force)
      setTarget(null)
      setNotice(null)
      // The row is about to disappear, so the page heading takes the focus.
      finishRemoveFocus(true)
      await read()
    } catch (error) {
      const code = errorCode(error)
      setRemoveProblem(code === "worktree_dirty" ? "dirty" : code === "worktree_unknown" ? "unknown" : "failed")
    } finally {
      if (alive.current) setRemoving(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
        <header className="flex flex-col gap-1">
          <h1 ref={headingRef} tabIndex={-1} className="text-lg font-semibold">
            {t("worktrees.title")}
          </h1>
          <p className="text-sm text-muted">{t("worktrees.description")}</p>
        </header>

        <p
          role="note"
          data-testid="worktrees-note"
          className="rounded-row border border-subtle bg-surface px-3 py-2 text-sm text-secondary"
        >
          {t("worktrees.note")}
        </p>

        {projectID === null ? null : (
          <p data-testid="worktrees-project" className="text-xs text-muted">
            {t("worktrees.project", { project: projectID })}
          </p>
        )}

        {status === "loading" ? (
          <div
            role="status"
            aria-live="polite"
            data-testid="worktrees-loading"
            className="flex items-center gap-2 text-sm text-muted"
          >
            <span className="loading loading-spinner loading-sm" aria-hidden="true" />
            {t("worktrees.loading")}
          </div>
        ) : status === "error" ? (
          <div className="flex flex-col items-start gap-2">
            <ErrorBanner message={t("worktrees.loadFailed")} />
            <button type="button" onClick={() => void load()} className="btn btn-sm">
              {t("worktrees.retry")}
            </button>
          </div>
        ) : rows.length === 0 ? (
          <p data-testid="worktrees-empty" className="text-sm text-muted">
            {t("worktrees.empty")}
          </p>
        ) : (
          <section aria-labelledby="worktrees-list-heading">
            <h2 id="worktrees-list-heading" className="text-base font-semibold">
              {t("worktrees.title")}
            </h2>
            <ul data-testid="worktrees-list" className="mt-2 flex flex-col gap-2">
              {rows.map((worktree) => (
                <li
                  key={worktree.directory}
                  data-testid="worktree-row"
                  className="flex flex-col gap-2 rounded-row border border-subtle bg-surface px-3 py-2 sm:flex-row sm:items-center"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <code className="break-all text-sm" data-testid="worktree-directory">
                      {worktree.directory}
                    </code>
                    <span className="text-xs text-muted">
                      {t("worktrees.branch")}:{" "}
                      {worktree.branch === undefined ? (
                        <span data-testid="worktree-branch-unknown">
                          {t("worktrees.branchUnknown")}
                        </span>
                      ) : (
                        <span data-testid="worktree-branch" className="text-secondary">
                          {worktree.branch}
                        </span>
                      )}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={(event) => openRemove(worktree, event.currentTarget)}
                    aria-label={t("worktrees.action.remove", { directory: worktree.directory })}
                    className="btn btn-ghost btn-sm self-start"
                  >
                    {t("worktrees.action.removeShort")}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {notice === null ? null : (
          <p role="status" data-testid="worktrees-notice" className="text-sm text-success">
            {notice}
          </p>
        )}

        <form
          aria-labelledby="worktrees-create-heading"
          className="flex flex-col gap-3 rounded-row border border-subtle bg-surface p-3"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <h2 id="worktrees-create-heading" className="text-base font-semibold">
            {t("worktrees.create.title")}
          </h2>
          <div className="flex flex-col gap-1">
            <label htmlFor="worktree-branch" className="text-sm font-medium">
              {t("worktrees.create.branch")}
            </label>
            <input
              id="worktree-branch"
              name="branch"
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              required
              className="input input-sm w-full"
              aria-describedby="worktree-branch-hint"
            />
            <span id="worktree-branch-hint" className="text-xs text-muted">
              {t("worktrees.create.branchHint")}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="worktree-from" className="text-sm font-medium">
              {t("worktrees.create.from")}
            </label>
            <input
              id="worktree-from"
              name="from"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className="input input-sm w-full"
              aria-describedby="worktree-from-hint"
            />
            <span id="worktree-from-hint" className="text-xs text-muted">
              {t("worktrees.create.fromHint")}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="worktree-name" className="text-sm font-medium">
              {t("worktrees.create.name")}
            </label>
            <input
              id="worktree-name"
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="input input-sm w-full"
              aria-describedby="worktree-name-hint"
            />
            <span id="worktree-name-hint" className="text-xs text-muted">
              {t("worktrees.create.nameHint")}
            </span>
          </div>
          {createProblem === null ? null : (
            <ErrorBanner
              message={
                createProblem === "exists"
                  ? t("worktrees.create.exists")
                  : createProblem === "limit"
                    ? t("worktrees.create.limit")
                    : t("worktrees.create.failed")
              }
            />
          )}
          <button
            type="submit"
            data-testid="worktree-create-submit"
            disabled={creating || branch.trim().length === 0}
            className="btn btn-primary btn-sm self-start"
          >
            {creating ? t("worktrees.create.creating") : t("worktrees.create.submit")}
          </button>
        </form>

        {target === null ? null : (
          <RemoveWorktreeDialog
            target={target}
            removing={removing}
            problem={removeProblem}
            onCancel={cancelRemove}
            onRemove={(force) => void remove(force)}
          />
        )}
      </div>
    </div>
  )
}
