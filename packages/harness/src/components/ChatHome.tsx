import { For, type Component } from "solid-js"
import { t } from "../i18n"
import { CHAT_STARTERS, chatGreeting } from "../chat"
import logo from "../assets/flupcode-logo.png"
import { Icon, type IconName } from "./Icon"

/** The empty Chat tab, like Claude's: a greeting over the input, both centred in the window. */
export const ChatHero: Component<{ displayName: string }> = (props) => {
  const greeting = () => {
    const { key, params } = chatGreeting(props.displayName, new Date().getHours())
    return t(key, params)
  }
  return (
    <div class="fc-chat-hero">
      <h1 class="fc-chat-greeting">
        <img class="fc-chat-greeting-logo" src={logo} alt="" />
        <span>{greeting()}</span>
      </h1>
    </div>
  )
}

const STARTER_ICONS: Record<(typeof CHAT_STARTERS)[number]["id"], IconName> = {
  write: "pencil",
  learn: "learn",
  ideas: "ideas",
  web: "globe",
}

/** Starters under the empty chat input; each fills the input with the beginning of a prompt. */
export const ChatStarters: Component<{ onPick: (text: string) => void }> = (props) => (
  <div class="fc-chat-starters">
    <For each={CHAT_STARTERS}>
      {(starter) => (
        <button
          class="fc-chat-starter"
          type="button"
          onClick={() => {
            props.onPick(t(starter.prompt))
            requestAnimationFrame(() => {
              const input = document.querySelector<HTMLTextAreaElement>(".fc-composer textarea.fc-input")
              if (!input) return
              input.focus()
              input.setSelectionRange(input.value.length, input.value.length)
            })
          }}
        >
          <Icon name={STARTER_ICONS[starter.id]} size={15} weight={1.8} />
          {t(starter.label)}
        </button>
      )}
    </For>
  </div>
)
