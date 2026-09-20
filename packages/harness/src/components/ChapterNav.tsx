import { For, Show, createSignal, type Component } from "solid-js"
import { t } from "../i18n"

export type Chapter = { id: string; title: string }

/** Most ticks shown; longer conversations group chapters under each tick. */
const MAX_TICKS = 12

/**
 * Claude Code's conversation navigator: a short stack of ticks at the top of the chat, one per
 * prompt, with the current one highlighted. Hovering lists the prompts to jump to.
 */
export const ChapterNav: Component<{
  chapters: Chapter[]
  activeId: string | undefined
  onJump: (id: string) => void
}> = (props) => {
  const [open, setOpen] = createSignal(false)
  let closeTimer: ReturnType<typeof setTimeout> | undefined

  const activeIndex = () =>
    Math.max(
      0,
      props.chapters.findIndex((chapter) => chapter.id === props.activeId),
    )
  const ticks = () => Math.min(MAX_TICKS, props.chapters.length)
  const activeTick = () => Math.floor((activeIndex() * ticks()) / props.chapters.length)

  const show = () => {
    clearTimeout(closeTimer)
    setOpen(true)
  }
  const hide = () => {
    clearTimeout(closeTimer)
    closeTimer = setTimeout(() => setOpen(false), 150)
  }

  return (
    <nav class="fc-chapters" aria-label={t("Conversation")} onMouseEnter={show} onMouseLeave={hide} onFocusIn={show}>
      <button
        class="fc-chapters-ticks"
        type="button"
        aria-label={t("Jump to a prompt")}
        onClick={() => setOpen((v) => !v)}
      >
        <For each={Array.from({ length: ticks() })}>
          {(_, index) => <span classList={{ "fc-chapters-tick-active": index() === activeTick() }} />}
        </For>
      </button>
      <Show when={open()}>
        <div class="fc-chapters-list" role="menu" onMouseEnter={show} onMouseLeave={hide}>
          <For each={props.chapters}>
            {(chapter, index) => (
              <button
                class="fc-chapters-item"
                classList={{ "fc-chapters-item-active": index() === activeIndex() }}
                type="button"
                role="menuitem"
                title={chapter.title}
                onClick={() => {
                  setOpen(false)
                  props.onJump(chapter.id)
                }}
              >
                <span class="fc-chapters-item-mark" aria-hidden="true" />
                <span class="fc-chapters-item-label">{chapter.title}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </nav>
  )
}
