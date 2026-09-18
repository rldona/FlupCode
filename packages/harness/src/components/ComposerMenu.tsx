import { For, Show, type Component, type JSX } from "solid-js"
import { t } from "../i18n"

export type MenuItem = {
  key: string
  label: string
  hint?: string
  disabled?: boolean
  /** Shown at the end instead of the hint, as a small tag. */
  soon?: boolean
}

/**
 * The `/` and `@` menu both composers draw (H-26).
 *
 * Same markup on a computer and a phone, because it is the same menu: the rules about when it opens
 * and what it offers live in `composer-menus`, and this is only how it looks.
 */
export const ComposerMenu: Component<{
  items: MenuItem[]
  active?: number
  onPick: (index: number) => void
  onHover?: (index: number) => void
  ref?: (element: HTMLDivElement) => void
  /** An action under the items, for the `@` menu's "save these as a pack". */
  footer?: JSX.Element
}> = (props) => (
  <div class="fc-command-menu" ref={(element) => props.ref?.(element)}>
    <For each={props.items}>
      {(item, index) => (
        <button
          class="fc-command-item"
          classList={{ "fc-command-item-active": props.active === index() && !item.disabled }}
          type="button"
          disabled={item.disabled}
          // Keep the field focused: a tap must not blur the draft before the pick is handled.
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => props.onHover?.(index())}
          onClick={() => props.onPick(index())}
        >
          <span class="fc-command-name">{item.label}</span>
          <Show when={item.hint}>
            <span class="fc-command-desc">{item.hint}</span>
          </Show>
          <Show when={item.soon}>
            <span class="fc-command-soon">{t("Soon")}</span>
          </Show>
        </button>
      )}
    </For>
    <Show when={props.footer}>{props.footer}</Show>
  </div>
)
