import { For, type Component } from "solid-js"
import { t } from "../i18n"
import { CHAT_STARTERS, chatGreeting } from "../chat"
import logo from "../assets/flupcode-logo.png"

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

const STARTER_ICONS: Record<(typeof CHAT_STARTERS)[number]["id"], string> = {
  write: "M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4ZM13.5 6.5l4 4",
  learn: "M3 9l9-5 9 5-9 5-9-5ZM7 11.5V16c0 1.5 2.2 3 5 3s5-1.5 5-3v-4.5",
  ideas: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z",
  web: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3Z",
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
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
            <path
              d={STARTER_ICONS[starter.id]}
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          {t(starter.label)}
        </button>
      )}
    </For>
  </div>
)
