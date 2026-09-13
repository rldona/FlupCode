import { Show, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import { touchDevice } from "../remote"
import logo from "../assets/flupcode-logo.png"

type OnboardingProps = {
  open: boolean
  serverHealthy: boolean | undefined
  serverInput: string
  onServerInput: (value: string) => void
  onConnect: () => void
  onDone: (name: string) => void
  /** Whether this device can control another computer (the web app, not the desktop host). */
  remoteClient: boolean
  onRemote: (name: string) => void
}

export const Onboarding: Component<OnboardingProps> = (props) => {
  const [name, setName] = createSignal("")
  const origin = () => (typeof window === "undefined" ? "http://localhost:4444" : window.location.origin)
  const command = () => `opencode serve --port 4096 --cors ${origin()}`
  // On touch devices the engine rarely runs locally, so controlling a computer comes first.
  const remoteFirst = () => props.remoteClient && touchDevice

  const nameField = () => (
    <label class="fc-settings-row">
      <span>{t("What's your name?")}</span>
      <input
        class="fc-question-custom"
        value={name()}
        placeholder={t("Your name")}
        onInput={(event) => setName(event.currentTarget.value)}
      />
    </label>
  )

  const localServer = () => (
    <>
      <div class="fc-onboarding-status" classList={{ "fc-onboarding-status-off": props.serverHealthy === false }}>
        {props.serverHealthy === undefined
          ? t("Checking the server…")
          : props.serverHealthy
            ? t("Server connected")
            : t("Server offline")}
      </div>

      <Show when={props.serverHealthy !== true}>
        <p class="fc-onboarding-text">{t("FlupCode needs the OpenCode engine. Start it, then connect:")}</p>
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
    </>
  )

  const getStarted = (primary: boolean) => (
    <button
      class="fc-button"
      classList={{ "fc-button-primary": primary }}
      type="button"
      disabled={props.serverHealthy !== true}
      onClick={() => props.onDone(name())}
    >
      {t("Get started")}
    </button>
  )

  const remoteOption = (primary: boolean) => (
    <div class="fc-onboarding-remote">
      <span class="fc-onboarding-remote-title">
        {primary ? t("Control a computer") : t("Or control another computer")}
      </span>
      <p class="fc-onboarding-text">
        {t(
          "Already use FlupCode on a computer? Open Remote control → Pair a device there and scan the code with this device.",
        )}
      </p>
      <button
        class="fc-button"
        classList={{ "fc-button-primary": primary }}
        type="button"
        onClick={() => props.onRemote(name())}
      >
        {t("Control a computer")}
      </button>
    </div>
  )

  return (
    <Show when={props.open}>
      <div class="fc-modal-backdrop">
        <div class="fc-modal fc-modal-wide" role="dialog" aria-modal="true" aria-label={t("Welcome to FlupCode")}>
          <div class="fc-onboarding">
            <div class="fc-onboarding-brand">
              <img src={logo} alt="" width="40" height="40" />
              <span class="fc-onboarding-logo">FlupCode</span>
            </div>
            <h2 class="fc-onboarding-title">{t("Welcome to FlupCode")}</h2>
            <p class="fc-onboarding-text">
              {t("A harness for OpenCode with a dashboard, routines and projects, on web and desktop.")}
            </p>

            <Show
              when={remoteFirst()}
              fallback={
                <>
                  {localServer()}
                  {nameField()}
                  {getStarted(true)}
                  <Show when={props.remoteClient}>{remoteOption(false)}</Show>
                </>
              }
            >
              {nameField()}
              {remoteOption(true)}
              <details class="fc-onboarding-local">
                <summary>{t("Use a server on this device")}</summary>
                {localServer()}
                {getStarted(false)}
              </details>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  )
}
