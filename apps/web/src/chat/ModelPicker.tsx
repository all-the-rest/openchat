import type { ModelInfo } from "@openchat/contracts"
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"
import { useT } from "../i18n/provider"
import { useCompletion } from "./completion"
import { favoriteKey, isStaleFavorite, type ModelFavorite } from "./favorites"

const PANEL =
  "dropdown-content absolute right-0 top-full z-50 mt-1 w-72 rounded-box " +
  "border border-subtle bg-base-200 p-2 shadow-lg"
const ROW =
  "flex min-w-0 flex-1 items-center gap-2 rounded-field px-2 py-1 text-left text-xs hover:bg-base-300"

interface Choice {
  model: string
  variant: string | null
}

/** Three tiny glyph badges; the accessible label carries the meaning. */
type CapabilityKey =
  | "chat.capabilityTools"
  | "chat.capabilityReasoning"
  | "chat.capabilityImage"

/** `128000` reads as `128k`; a host that reports nothing stays blank. */
function formatContext(limit: number): string | null {
  if (limit <= 0) return null
  return limit >= 1000 ? `${Math.round(limit / 1000)}k` : String(limit)
}

function CapabilityBadges({ model }: { model: ModelInfo }) {
  const t = useT()
  const context = formatContext(model.contextLimit)
  const badges: Array<[boolean, CapabilityKey, string]> = [
    [model.capabilities.tools, "chat.capabilityTools", "⚙"],
    [model.capabilities.reasoning, "chat.capabilityReasoning", "✧"],
    [model.capabilities.image, "chat.capabilityImage", "▣"],
  ]
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1">
      {context ? (
        <span
          className="text-[10px] text-muted"
          title={t("chat.contextWindow", { tokens: String(model.contextLimit) })}
        >
          {context}
        </span>
      ) : null}
      {badges.map(([enabled, key, glyph]) =>
        enabled ? (
          <span
            key={key}
            role="img"
            aria-label={t(key)}
            title={t(key)}
            className="badge badge-xs badge-ghost px-1"
          >
            {glyph}
          </span>
        ) : null,
      )}
    </span>
  )
}

interface RowProps {
  label: string
  model: ModelInfo | null
  active: boolean
  stale: boolean
  favorite: boolean
  onChoose: () => void
  onFavorite: () => void
}

/** One keyboard-reachable option plus its one-click star. */
function OptionRow({
  label, model, active, stale, favorite, onChoose, onFavorite,
}: RowProps) {
  const t = useT()
  return (
    <div className="flex items-center gap-1" data-testid="model-option-row">
      <button
        type="button"
        role="menuitem"
        data-testid="model-option"
        data-model-option={true}
        aria-current={active ? "true" : undefined}
        disabled={stale}
        onClick={onChoose}
        className={`${ROW} ${active ? "bg-base-300" : ""}`}
      >
        <span className="truncate">{label}</span>
        {model ? <CapabilityBadges model={model} /> : null}
        {model?.status === "deprecated" ? (
          <span className="badge badge-xs badge-warning">{t("chat.deprecated")}</span>
        ) : null}
        {stale ? (
          <span className="badge badge-xs badge-warning">{t("chat.stale")}</span>
        ) : null}
      </button>
      <button
        type="button"
        data-testid="favorite-toggle"
        aria-label={t(favorite ? "chat.favoriteRemove" : "chat.favoriteAdd", { name: label })}
        aria-pressed={favorite}
        onClick={onFavorite}
        className="btn btn-ghost btn-xs shrink-0 px-1"
      >
        {favorite ? "★" : "☆"}
      </button>
    </div>
  )
}

/**
 * Compact model combobox: provider groups, a second level of variants, search,
 * capability badges and favourites. It is a button plus a controlled menu so
 * every row is reachable with Tab and arrow keys without a new dependency.
 */
export function ModelSelect({ className = "" }: { className?: string }) {
  const t = useT()
  const { models, model, variant, setModel, favorites, toggleFavorite, loaded } =
    useCompletion()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener("pointerdown", onPointer)
    return () => document.removeEventListener("pointerdown", onPointer)
  }, [open])

  const activeModel = models.find((entry) => entry.id === model)
  const activeName = activeModel?.name ?? t("chat.defaultChoice")
  const label = activeModel && variant ? `${activeName}: ${variant}` : activeName

  const needle = query.trim().toLocaleLowerCase()
  const filtered = useMemo(
    () => models.filter((entry) =>
      !needle ||
      entry.name.toLocaleLowerCase().includes(needle) ||
      entry.providerName.toLocaleLowerCase().includes(needle) ||
      entry.providerID.toLocaleLowerCase().includes(needle)),
    [models, needle],
  )
  const visibleFavorites = favorites.filter((favorite) => {
    const entry = models.find((item) => item.id === favorite.model)
    return (
      !needle ||
      favorite.model.toLocaleLowerCase().includes(needle) ||
      (entry?.name.toLocaleLowerCase().includes(needle) ?? false) ||
      (entry?.providerName.toLocaleLowerCase().includes(needle) ?? false)
    )
  })
  const groups = useMemo(() => {
    const byProvider = new Map<string, ModelInfo[]>()
    for (const entry of filtered) {
      const list = byProvider.get(entry.providerID) ?? []
      list.push(entry)
      byProvider.set(entry.providerID, list)
    }
    return [...byProvider.entries()].map(([id, entries]) => ({
      id, name: entries[0]?.providerName ?? id, entries,
    }))
  }, [filtered])

  const choose = (choice: Choice) => {
    setModel(choice.model, choice.variant)
    setOpen(false)
    setQuery("")
    triggerRef.current?.focus()
  }
  const star = (favorite: ModelFavorite) => toggleFavorite(favorite)
  const isFavorite = (favorite: ModelFavorite) =>
    favorites.some((entry) => favoriteKey(entry) === favoriteKey(favorite))

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
      return
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    // The closed trigger opens from the keyboard as well; the next arrow key
    // then walks the rendered rows.
    if (!open) {
      event.preventDefault()
      setOpen(true)
      return
    }
    const options = [
      ...(panelRef.current?.querySelectorAll<HTMLButtonElement>(
        "[data-model-option]:not([disabled])",
      ) ?? []),
    ]
    if (options.length === 0) return
    event.preventDefault()
    const index = options.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === "ArrowDown"
      ? (index + 1) % options.length
      : (index - 1 + options.length) % options.length
    options[next]?.focus()
  }

  const favoriteRow = (favorite: ModelFavorite) => {
    const entry = models.find((item) => item.id === favorite.model)
    const stale = isStaleFavorite(favorite, models)
    const variantText =
      favorite.variant ?? (entry && entry.variants.length > 0 ? t("chat.defaultChoice") : null)
    const label = `${entry?.name ?? favorite.model}${variantText ? `: ${variantText}` : ""}`
    return (
      <OptionRow
        key={favoriteKey(favorite)}
        label={label}
        model={entry ?? null}
        stale={stale}
        active={model === favorite.model && variant === favorite.variant}
        favorite={true}
        onChoose={() => choose({ model: favorite.model, variant: favorite.variant })}
        onFavorite={() => star(favorite)}
      />
    )
  }

  const modelRows = (entry: ModelInfo) => {
    const choices: Choice[] = [
      { model: entry.id, variant: null },
      ...entry.variants.map((name): Choice => ({ model: entry.id, variant: name })),
    ]
    return choices.map((choice) => {
      const text =
        choice.variant === null && entry.variants.length > 0
          ? `${entry.name}: ${t("chat.defaultChoice")}`
          : choice.variant === null
            ? entry.name
            : `${entry.name}: ${choice.variant}`
      const favorite: ModelFavorite = { model: entry.id, variant: choice.variant }
      return (
        <OptionRow
          key={favoriteKey(favorite)}
          label={text}
          model={entry}
          stale={false}
          active={model === choice.model && variant === choice.variant}
          favorite={isFavorite(favorite)}
          onChoose={() => choose(choice)}
          onFavorite={() => star(favorite)}
        />
      )
    })
  }

  // With no catalogue and no favourites there is nothing to choose; the same
  // guard in CompletionPickers hides the whole header group in that case.
  if (!loaded || (models.length === 0 && favorites.length === 0)) return null

  return (
    <div className={`relative ${className}`.trim()} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        data-testid="model-select"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="btn btn-ghost btn-sm max-w-[12rem] gap-1 text-xs"
      >
        <span className="sr-only">{t("chat.modelLabel")}: </span>
        <span className="truncate">{label}</span>
        <span aria-hidden="true" className="text-[10px]">▾</span>
      </button>
      {open ? (
        <div
          ref={panelRef}
          data-testid="model-menu"
          aria-label={t("chat.modelLabel")}
          className={PANEL}
        >
          <input
            type="search"
            data-testid="model-search"
            aria-label={t("chat.modelSearch")}
            placeholder={t("chat.modelSearch")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="input input-xs mb-1 w-full"
          />
          {visibleFavorites.length > 0 ? (
            <div
              role="menu"
              aria-label={t("chat.favorites")}
              className="border-b border-base-300 pb-1"
            >
              <div className="menu-title text-xs">{t("chat.favorites")}</div>
              {visibleFavorites.map(favoriteRow)}
            </div>
          ) : null}
          <div role="menu" aria-label={t("chat.allModels")} className="pt-1">
            <div className="menu-title text-xs">{t("chat.allModels")}</div>
            {groups.map((group) => (
              <div key={group.id} role="group" aria-label={group.name}>
                <div className="menu-title text-xs opacity-60">{group.name}</div>
                {group.entries.map(modelRows)}
              </div>
            ))}
            {groups.length === 0 ? (
              <p className="px-2 py-1 text-xs text-muted">{t("chat.noModels")}</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
