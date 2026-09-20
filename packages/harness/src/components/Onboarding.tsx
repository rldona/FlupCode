import { Show, createSignal, type Component } from "solid-js"
import { t } from "../i18n"

type OnboardingProps = {
  open: boolean
  serverHealthy: boolean | undefined
  serverInput: string
  onServerInput: (value: string) => void
  onConnect: () => void
  onDone: (name: string) => void
}

export const Onboarding: Component<OnboardingProps> = (props) => {
  const [name, setName] = createSignal("")
  const origin = () => (typeof window === "undefined" ? "http://localhost:4444" : window.location.origin)
  const command = () => `opencode serve --port 4096 --cors ${origin()}`

  return (
    <Show when={props.open}>
      <div class="fc-modal-backdrop">
        <div class="fc-modal fc-modal-wide" role="dialog" aria-modal="true">
          <div class="fc-onboarding">
            <span class="fc-onboarding-logo">FlupCode</span>
            <h2 class="fc-onboarding-title">{t("Welcome to FlupCode")}</h2>
            <p class="fc-onboarding-text">
              {t("A harness for OpenCode with a dashboard, routines and projects, on web and desktop.")}
            </p>

            <div class="fc-onboarding-status" classList={{ "fc-onboarding-status-off": props.serverHealthy === false }}>
              {props.serverHealthy === undefined
                ? t("Checking the server…")
                : props.serverHealthy
                  ? t("Server connected")
                  : t("Server offline")}
            </div>

            <Show when={props.serverHealthy !== true}>
              <p class="fc-onboarding-text">
                {t("FlupCode needs the OpenCode engine. Start it, then connect:")}
              </p>
              <pre class="fc-onboarding-code">
                <code>{command()}</code>
              </pre>
              <label class="fc-settings-row">
                <span>{t("Server")}</span>
                <input
                  class="fc-question-custom"
                  value={props.serverInput}
                  spellcheck={false}
                  placeholder="http://localhost:4096"
                  onInput={(event) => props.onServerInput(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") props.onConnect()
                  }}
                />
              </label>
              <button class="fc-button" type="button" onClick={props.onConnect}>
                {t("Connect")}
              </button>
            </Show>

            <label class="fc-settings-row">
              <span>{t("What's your name?")}</span>
              <input
                class="fc-question-custom"
                value={name()}
                placeholder={t("Your name")}
                onInput={(event) => setName(event.currentTarget.value)}
              />
            </label>

            <button
              class="fc-button fc-button-primary"
              type="button"
              disabled={props.serverHealthy !== true}
              onClick={() => props.onDone(name())}
            >
              {t("Get started")}
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
