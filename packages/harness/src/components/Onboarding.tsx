import { Show, createSignal, type Component } from "solid-js"
import { t } from "../i18n"

type OnboardingProps = {
  open: boolean
  serverHealthy: boolean | undefined
  onDone: (name: string) => void
}

export const Onboarding: Component<OnboardingProps> = (props) => {
  const [name, setName] = createSignal("")

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

            <label class="fc-settings-row">
              <span>{t("What's your name?")}</span>
              <input
                class="fc-question-custom"
                value={name()}
                placeholder={t("Your name")}
                onInput={(event) => setName(event.currentTarget.value)}
              />
            </label>

            <button class="fc-button fc-button-primary" type="button" onClick={() => props.onDone(name())}>
              {t("Get started")}
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
