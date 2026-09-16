import { For, Show, type Component } from "solid-js"
import type { SkillInfo } from "../engine-types"
import { t } from "../i18n"

type SkillsPanelProps = {
  open: boolean
  skills: SkillInfo[]
  onInsert: (name: string) => void
  onClose: () => void
}

export const SkillsPanel: Component<SkillsPanelProps> = (props) => {
  return (
    <Show when={props.open}>
      <div class="fc-modal-backdrop" onClick={props.onClose}>
        <div
          class="fc-modal fc-modal-wide"
          role="dialog"
          aria-modal="true"
          aria-label={t("Skills")}
          onClick={(event) => event.stopPropagation()}
        >
          <div class="fc-modal-header">
            <span>{t("Skills")}</span>
            <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={props.onClose}>
              ×
            </button>
          </div>
          <Show
            when={props.skills.length > 0}
            fallback={
              <div class="fc-empty-state">
                <span class="fc-empty-title">{t("No skills")}</span>
              </div>
            }
          >
            <ul class="fc-skill-list">
              <For each={props.skills}>
                {(skill) => (
                  <li class="fc-skill-row">
                    <div class="fc-skill-info">
                      <span class="fc-skill-name">{skill.name}</span>
                      <Show when={skill.description}>
                        <span class="fc-skill-desc">{skill.description}</span>
                      </Show>
                    </div>
                    <button class="fc-button" type="button" onClick={() => props.onInsert(skill.name)}>
                      {t("Insert")}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </div>
    </Show>
  )
}
