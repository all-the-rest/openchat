import type { ReactNode } from "react"
import {
  AppsIcon,
  ArtifactsIcon,
  ChevronDownIcon,
  CopyIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
  ToolIcon,
} from "../components/icons"
import type { PaletteAction, PaletteItem } from "./items"

const OPTION_CLASS =
  "flex cursor-pointer items-start gap-2 rounded-row px-3 py-2 text-sm text-secondary"

/** DOM id of one option; `aria-activedescendant` and the list use the same. */
export function optionID(id: string): string {
  return `palette-option-${id}`
}

function ItemIcon({ action }: { action: PaletteAction | undefined }) {
  const className = "mt-0.5 size-4 shrink-0"
  switch (action) {
    case "newChat":
      return <PlusIcon className={className} />
    case "chat":
      return <SearchIcon className={className} />
    case "settings":
      return <SettingsIcon className={className} />
    case "apps":
      return <AppsIcon className={className} />
    case "artifacts":
      return <ArtifactsIcon className={className} />
    case "code":
      return <ToolIcon className={className} />
    case "theme":
      return <SunIcon className={className} />
    case "language":
      return <ChevronDownIcon className={className} />
    case "copyAnswer":
      return <CopyIcon className={className} />
    default:
      return <SearchIcon className={className} />
  }
}

export function PaletteSection({ children }: { children: ReactNode }) {
  return (
    <li
      role="presentation"
      className="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-muted"
    >
      {children}
    </li>
  )
}

/**
 * One listbox option. The input keeps focus and points at this node with
 * `aria-activedescendant`, so the option itself is not a tab stop. A disabled
 * action stays readable but is skipped by the keyboard and does nothing.
 */
export function PaletteOption({
  item,
  active,
  onActivate,
  onRun,
}: {
  item: PaletteItem
  active: boolean
  onActivate: () => void
  onRun: () => void
}) {
  return (
    <li
      id={optionID(item.id)}
      role="option"
      aria-selected={active}
      aria-disabled={item.disabled || undefined}
      data-testid={item.kind === "chat" ? "palette-chat-option" : "palette-option"}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={onActivate}
      onClick={onRun}
      className={`${OPTION_CLASS} ${active ? "bg-selected" : ""} ${
        item.disabled ? "cursor-not-allowed opacity-60" : ""
      }`}
    >
      {item.kind === "action" ? (
        <ItemIcon action={item.action} />
      ) : (
        <SearchIcon className="mt-0.5 size-4 shrink-0" />
      )}
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{item.label}</span>
        {item.hint ? <span className="line-clamp-2 text-xs text-muted">{item.hint}</span> : null}
      </span>
    </li>
  )
}
