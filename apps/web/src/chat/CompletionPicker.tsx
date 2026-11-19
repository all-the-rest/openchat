import { useT } from "../i18n/provider"
import { useCompletionOrNull } from "./completion"
import { ModelSelect } from "./ModelPicker"

const SELECT =
  "select select-sm max-w-[10rem] border border-subtle bg-surface text-xs text-secondary"

/** The model is a grouped combobox with variants and favourites. */
export { ModelSelect }

/** The agent half of the same persisted choice. */
export function AgentSelect({ className = "" }: { className?: string }) {
  const t = useT()
  const completion = useCompletionOrNull()
  if (!completion?.loaded || completion.agents.length === 0) return null
  const { agent, agents, setAgent } = completion
  return (
    <label className={`flex items-center gap-1 ${className}`.trim()}>
      <span className="sr-only">{t("chat.agentLabel")}</span>
      <select
        data-testid="agent-select"
        aria-label={t("chat.agentLabel")}
        title={t("chat.agentLabel")}
        value={agent ?? ""}
        onChange={(event) => setAgent(event.target.value || null)}
        className={`${SELECT}`}
      >
        <option value="">{t("chat.defaultChoice")}</option>
        {agents.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.name}
          </option>
        ))}
      </select>
    </label>
  )
}

/** Header controls plus the active choice shown beside the chat title. */
export function CompletionPickers() {
  const t = useT()
  const completion = useCompletionOrNull()
  if (!completion) return null
  const { model, variant, agent, models, agents, loaded } = completion
  const hasModels = loaded && (models.length > 0 || completion.favorites.length > 0)
  const hasAgents = loaded && agents.length > 0
  if (!hasModels && !hasAgents) return null

  const modelName = models.find((entry) => entry.id === model)?.name ?? t("chat.defaultChoice")
  const agentName = agents.find((entry) => entry.id === agent)?.name ?? t("chat.defaultChoice")
  const activeText = variant
    ? t("chat.activeChoiceVariant", { model: modelName, variant, agent: agentName })
    : t("chat.activeChoice", { model: modelName, agent: agentName })

  return (
    <div className="flex shrink-0 items-center gap-2">
      <ModelSelect />
      <AgentSelect />
      <span data-testid="completion-active" className="hidden text-xs text-muted xl:inline">
        {activeText}
      </span>
    </div>
  )
}
