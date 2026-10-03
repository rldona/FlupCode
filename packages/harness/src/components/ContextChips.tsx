import { For, Show, type Component } from "solid-js"
import type { ContextChip } from "../context-chip"
import { t } from "../i18n"
import { Icon } from "./Icon"

/** The word each chip's source goes by elsewhere in the app (P5). */
const KIND: Record<ContextChip["type"], string> = {
  file: "File",
  artifact: "Artifact",
  hunk: "Changes",
  terminal: "Terminal",
  check: "CI",
  preview: "Preview",
}

/**
 * What the reader pointed at, above the input of both composer layouts (UX-05): each chip says what
 * it is and where it came from, can be removed until the message goes, and says so when what it
 * points at is gone or too long to send whole.
 */
export const ContextChips: Component<{ chips: ContextChip[]; onRemove?: (id: string) => void }> = (props) => (
  <Show when={props.chips.length > 0}>
    <div class="fc-dock-chips">
      <For each={props.chips}>
        {(chip) => (
          <span
            class="fc-composer-chip"
            classList={{ "fc-composer-chip-missing": chip.problem === "missing" }}
            data-type={chip.type}
            title={[
              chip.source,
              chip.type === "preview" ? chip.note : undefined,
              chip.problem === "missing" ? t("It can no longer be found.") : undefined,
              chip.problem === "cut" ? t("Only the start is sent.") : undefined,
            ]
              .filter(Boolean)
              .join("\n")}
          >
            <Show when={chip.type === "preview" && chip.image}>
              {(image) => <img class="fc-composer-chip-image" src={image()} alt="" />}
            </Show>
            <span class="fc-composer-chip-kind">{chip.problem === "missing" ? t("Missing") : t(KIND[chip.type])}</span>
            <span class="fc-composer-chip-label">{chip.label}</span>
            <Show when={chip.problem === "cut"}>
              <span class="fc-composer-chip-cut">{t("Only the start is sent.")}</span>
            </Show>
            <button
              class="fc-composer-chip-remove"
              type="button"
              aria-label={`${t("Remove")} ${chip.label}`}
              onClick={() => props.onRemove?.(chip.id)}
            >
              <Icon name="close" size={12} weight={1.8} />
            </button>
          </span>
        )}
      </For>
    </div>
  </Show>
)
