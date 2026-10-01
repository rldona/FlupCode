import { Show, createSignal, type Component } from "solid-js"
import { t } from "../i18n"
import { touchDevice } from "../remote"
import type { LocalNetworkState } from "../local-network"
import logo from "../assets/flupcode-logo.png"

type OnboardingProps = {
  open: boolean
  serverHealthy: boolean | undefined
  /** The engine is reachable but the browser blocked the response (CORS, mixed content, LNA). */
  serverBlocked: boolean
  /** The engine answers `401`/`403`: it was started with a password a browser page cannot send. */
  serverAuthRequired: boolean
  /** The browser's Local Network Access permission, when this page needs one (H-45). */
  localNetwork: LocalNetworkState
  allowingLocalNetwork: boolean
  onAllowLocalNetwork: () => void
  serverInput: string
  onServerInput: (value: string) => void
  onConnect: () => void
  onDone: (name: string) => void
  /** Whether this device can control another computer (the web app, not the desktop host). */
  remoteClient: boolean
  onRemote: (name: string) => void
}

const DESKTOP_DOWNLOAD = "https://github.com/rldona/FlupCode/releases/latest"
const GETTING_STARTED = "https://github.com/rldona/FlupCode/blob/main/docs/GETTING-STARTED.md"

export const Onboarding: Component<OnboardingProps> = (props) => {
  const [name, setName] = createSignal("")
  const [copied, setCopied] = createSignal(false)
  // OpenCode 2 always asks for a password a page cannot send; `flupcode serve` runs it and signs this
  // page in (2.1).
  const command = () => "flupcode serve"
  // On touch devices the engine rarely runs locally, so controlling a computer comes first.
  const remoteFirst = () => props.remoteClient && touchDevice

  let copiedTimer: number | undefined
  const copy = (value: string) => {
    void navigator.clipboard?.writeText(value)
    setCopied(true)
    clearTimeout(copiedTimer)
    copiedTimer = window.setTimeout(() => setCopied(false), 1500)
  }

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
            : props.serverBlocked
              ? t("Connection blocked by the browser")
              : props.serverAuthRequired
                ? t("Authentication required")
                : t("Server offline")}
      </div>

      <Show when={props.serverBlocked}>
        <p class="fc-onboarding-text">
          {props.localNetwork === "unsupported"
            ? t(
                "The engine is running, but the browser refused the connection. Start it with the command below and connect again.",
              )
            : props.localNetwork === "denied"
              ? t(
                  "The engine is running, but local network access is blocked for this site. Allow it in your browser's site settings, then connect again.",
                )
              : t("The engine is running. This web page needs your permission to reach it on this device.")}{" "}
          <a class="fc-link" href={GETTING_STARTED} target="_blank" rel="noreferrer">
            {t("Troubleshooting")}
          </a>
        </p>
        <Show when={props.localNetwork === "prompt"}>
          <button
            class="fc-button fc-button-primary"
            type="button"
            disabled={props.allowingLocalNetwork}
            onClick={props.onAllowLocalNetwork}
          >
            {props.allowingLocalNetwork ? t("Asking…") : t("Allow access")}
          </button>
        </Show>
      </Show>

      <Show when={props.serverAuthRequired}>
        <p class="fc-onboarding-text">
          {t(
            "This engine is OpenCode 2, which always runs behind a password, and a browser page has no way to send one. Open FlupCode's desktop app instead: it starts the engine and signs in for you.",
          )}
        </p>
      </Show>

      <Show when={props.serverHealthy !== true && !props.serverAuthRequired}>
        <p class="fc-onboarding-text">
          {t("Start FlupCode's engine on this computer and leave it running, or keep the desktop app open:")}
        </p>
        <p class="fc-onboarding-text">
          {t("It runs OpenCode 2 and signs this page in.")}{" "}
          <a class="fc-link" href={GETTING_STARTED} target="_blank" rel="noreferrer">
            {t("Get the flupcode command")}
          </a>
        </p>
        <div class="fc-onboarding-command">
          <pre class="fc-onboarding-code">
            <code>{command()}</code>
          </pre>
          <button class="fc-button" type="button" onClick={() => copy(command())}>
            {copied() ? t("Copied") : t("Copy command")}
          </button>
        </div>
        <p class="fc-onboarding-text">
          {t("It answers at http://localhost:4096. Use another port with --port and change the server below.")}
        </p>
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
        <Show when={props.remoteClient}>
          <p class="fc-onboarding-text">
            {t("No terminal? Use the desktop app, which starts the engine for you:")}{" "}
            <a class="fc-link" href={DESKTOP_DOWNLOAD} target="_blank" rel="noreferrer">
              {t("Download FlupCode")}
            </a>
          </p>
        </Show>
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
