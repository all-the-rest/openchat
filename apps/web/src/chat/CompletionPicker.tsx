import { useT } from "../i18n/provider"
import { useCompletionOrNull } from "./completion"

const SELECT =
  "select select-sm max-w-[10rem] border border-subtle bg-surface text-xs text-secondary"

/** One compact catalogue select. Hidden when the host has no such catalogue. */
export function ModelSelect({ className = "" }: { className?: string }) {
  const t = useT()
  const completion = useCompletionOrNull()
  if (!completion?.loaded || completion.models.length === 0) return null
  const { model, models, setModel } = completion
  return (
    <label className={`flex items-center gap-1 ${className}`.trim()}>
      <span className="sr-only">{t("chat.modelLabel")}</span>
      <select
        data-testid="model-select"
        aria-label={t("chat.modelLabel")}
        title={t("chat.modelLabel")}
        value={model ?? ""}
        onChange={(event) => setModel(event.target.value || null)}
        className={`${SELECT}`}
      >
        <option value="">{t("chat.defaultChoice")}</option>
        {models.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.name}
          </option>
        ))}
      </select>
    </label>
  )
}

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
  const { model, agent, models, agents, loaded } = completion
  const hasModels = loaded && models.length > 0
  const hasAgents = loaded && agents.length > 0
  if (!hasModels && !hasAgents) return null

  const modelName = models.find((entry) => entry.id === model)?.name ?? t("chat.defaultChoice")
  const agentName = agents.find((entry) => entry.id === agent)?.name ?? t("chat.defaultChoice")

  return (
    <div className="flex shrink-0 items-center gap-2">
      <ModelSelect />
      <AgentSelect />
      <span data-testid="completion-active" className="hidden text-xs text-muted xl:inline">
        {t("chat.activeChoice", { model: modelName, agent: agentName })}
      </span>
    </div>
  )
}
