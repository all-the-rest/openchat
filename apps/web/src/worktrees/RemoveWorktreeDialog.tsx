import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react"
import type { WorktreeInfo } from "@openchat/contracts"
import { ErrorBanner } from "../components/ErrorBanner"
import { useT } from "../i18n/provider"

export type RemoveProblem = "dirty" | "unknown" | "failed"

/**
 * The removal confirmation of `/worktrees` (spec 06, FR-23). It is a modal
 * `alertdialog`: focus moves to the safe Cancel action on open, `Tab` wraps
 * inside the dialog, and `Escape` takes the same cancel path as the button.
 * The page restores focus to the row that opened it.
 */
export function RemoveWorktreeDialog({
  target,
  removing,
  problem,
  onCancel,
  onRemove,
}: {
  target: WorktreeInfo
  removing: boolean
  problem: RemoveProblem | null
  onCancel: () => void
  onRemove: (force: boolean) => void
}) {
  const t = useT()
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      onCancel()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [onCancel])

  // A modal dialog owns Tab: the cycle wraps between its first and last button.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [],
    )
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (first === undefined || last === undefined) {
      event.preventDefault()
      dialogRef.current?.focus()
      return
    }
    const active = document.activeElement
    const inside = dialogRef.current?.contains(active) === true
    if (event.shiftKey) {
      if (!inside || active === first) {
        event.preventDefault()
        last.focus()
      }
    } else if (!inside || active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      ref={dialogRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="worktree-remove-title"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-testid="worktree-remove-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-app/70 p-4"
    >
      <div className="flex w-full max-w-md flex-col gap-3 rounded-card border border-subtle bg-elevated p-4">
        <h2 id="worktree-remove-title" className="text-base font-semibold">
          {t("worktrees.remove.title")}
        </h2>
        <p className="text-sm text-secondary">
          {t("worktrees.remove.body", { directory: target.directory })}
        </p>
        <p className="text-sm text-secondary">{t("worktrees.remove.dirtyBody")}</p>
        {problem === null ? null : (
          <ErrorBanner
            message={
              problem === "dirty"
                ? t("worktrees.remove.dirty")
                : problem === "unknown"
                  ? t("worktrees.remove.unknown")
                  : t("worktrees.remove.failed")
            }
          />
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            ref={cancelRef}
            onClick={onCancel}
            disabled={removing}
            className="btn btn-ghost btn-sm"
          >
            {t("worktrees.remove.cancel")}
          </button>
          <button
            type="button"
            data-testid="worktree-remove-confirm"
            onClick={() => onRemove(false)}
            disabled={removing}
            className="btn btn-sm"
          >
            {removing ? t("worktrees.remove.busy") : t("worktrees.remove.confirm")}
          </button>
          <button
            type="button"
            data-testid="worktree-remove-force"
            onClick={() => onRemove(true)}
            disabled={removing}
            className="btn btn-error btn-sm"
          >
            {t("worktrees.remove.force")}
          </button>
        </div>
      </div>
    </div>
  )
}
