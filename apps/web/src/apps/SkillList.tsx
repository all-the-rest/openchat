import type { AppSkill } from "@openchat/contracts"
import { useT } from "../i18n/provider"

/**
 * Skills the workspace offers. They have no connect/disconnect action: the
 * host owns their configuration and autoinvoke choice.
 */
export function SkillList({ skills }: { skills: AppSkill[] }) {
  const t = useT()

  return (
    <section aria-labelledby="apps-skills-heading" className="flex flex-col gap-2">
      <h2 id="apps-skills-heading" className="text-sm font-semibold">
        {t("apps.skills")}
      </h2>
      {skills.length === 0 ? (
        <p className="text-sm text-muted">{t("apps.noSkills")}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {skills.map((skill) => (
            <li
              key={skill.id}
              data-testid="apps-skill"
              className="flex flex-col gap-0.5 rounded-row border border-subtle bg-surface px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{skill.name}</span>
                {skill.autoinvoke ? (
                  <span
                    data-testid="apps-skill-auto"
                    title={t("apps.autoHint")}
                    className="badge badge-sm badge-outline"
                  >
                    {t("apps.auto")}
                  </span>
                ) : null}
              </div>
              {skill.description ? (
                <p className="line-clamp-2 text-xs text-muted">{skill.description}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
