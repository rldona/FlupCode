import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js"
import QRCode from "qrcode"
import type { RemoteHostState } from "@flupcode/remote"
import { t } from "../i18n"
import { toast } from "../toast"
import { desktopRemote, remote, type RemoteErrorCode } from "../remote"
import { enginePort, lanServeCommand, tunnelCommand } from "../remote-share"
import { RemoteNotifications } from "./RemoteNotifications"

type RemotePanelProps = {
  open: boolean
  initialUrl: string
  onClose: () => void
  onBack?: () => void
}

function qr(value: string, width = 220) {
  return QRCode.toString(value, { type: "svg", margin: 1, width }).catch(() => "")
}

function relativeTime(timestamp: number) {
  const minutes = Math.round((Date.now() - timestamp) / 60_000)
  if (minutes < 1) return t("just now")
  if (minutes < 60) return t("{count} min ago", { count: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 48) return t("{count} h ago", { count: hours })
  return new Date(timestamp).toLocaleDateString()
}

const ERRORS: Record<RemoteErrorCode, string> = {
  insecure: "Remote control needs HTTPS. Open FlupCode from its secure address.",
  offline: "The computer is offline or remote control is turned off.",
  revoked: "This device was removed on the computer. Pair it again.",
  expired: "The pairing code expired or was already used. Create a new one on the computer.",
  failed: "Could not connect to the computer.",
}

const HostView: Component<{ bridge: NonNullable<ReturnType<typeof desktopRemote>> }> = (props) => {
  const [state, setState] = createSignal<RemoteHostState>()
  const [svg, setSvg] = createSignal("")
  const [now, setNow] = createSignal(Date.now())
  const [relay, setRelay] = createSignal("")

  const run = (work: () => Promise<RemoteHostState>) =>
    void work()
      .then(setState)
      .catch((cause: unknown) => toast(cause instanceof Error ? cause.message : String(cause), "error"))

  void props.bridge.state().then((next) => {
    setState(next)
    setRelay(next.relay)
  })
  onCleanup(props.bridge.onChange(setState))

  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))

  createEffect(() => {
    const url = state()?.pairing?.url
    if (!url) return setSvg("")
    void qr(url).then(setSvg)
  })

  const connectionLabel = () => {
    const current = state()
    if (!current?.enabled) return t("Off")
    if (current.connection === "online") return t("Online")
    if (current.connection === "connecting") return t("Connecting")
    return t("Offline")
  }

  const remaining = () => {
    const expiresAt = state()?.pairing?.expiresAt
    if (!expiresAt) return ""
    const seconds = Math.max(0, Math.round((expiresAt - now()) / 1000))
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
  }

  return (
    <Show when={state()}>
      {(current) => (
        <>
          <p class="fc-modal-line">
            {t("Control this computer's sessions from your phone, on any network. Traffic is end-to-end encrypted.")}
          </p>
          <section class="fc-settings-section">
            <div class="fc-settings-row">
              <span>{t("This computer")}</span>
              <span class="fc-settings-status">{current().hostName}</span>
            </div>
            <div class="fc-settings-row">
              <span>{t("Allow remote control")}</span>
              <span class="fc-remote-actions">
                <span
                  class="fc-status"
                  classList={{
                    "fc-status-on": current().enabled && current().connection === "online",
                    "fc-status-off": current().enabled && current().connection === "offline",
                  }}
                >
                  {connectionLabel()}
                </span>
                <button
                  class="fc-chip fc-chip-button"
                  classList={{ "fc-chip-active": current().enabled }}
                  type="button"
                  onClick={() => run(() => props.bridge.setEnabled(!current().enabled))}
                >
                  {current().enabled ? t("On") : t("Off")}
                </button>
              </span>
            </div>
            <Show when={current().enabled && current().detail}>
              <p class="fc-settings-status">{current().detail}</p>
            </Show>
          </section>

          <Show when={current().enabled}>
            <section class="fc-settings-section">
              <h3 class="fc-settings-title">{t("Pair a device")}</h3>
              <Show
                when={current().pairing}
                fallback={
                  <div class="fc-settings-row">
                    <span class="fc-settings-status">{t("Show a QR code and scan it with your phone's camera.")}</span>
                    <button
                      class="fc-button fc-button-primary"
                      type="button"
                      disabled={current().connection !== "online"}
                      onClick={() => run(() => props.bridge.createPairing())}
                    >
                      {t("Pair a device")}
                    </button>
                  </div>
                }
              >
                {(pairing) => (
                  <div class="fc-remote-pairing">
                    <div class="fc-qr" innerHTML={svg()} />
                    <p class="fc-settings-status">
                      {t("Scan with your phone. The code works once and expires in {time}.", { time: remaining() })}
                    </p>
                    <div class="fc-modal-links">
                      <button
                        class="fc-button"
                        type="button"
                        onClick={() => void navigator.clipboard?.writeText(pairing().url)}
                      >
                        {t("Copy link")}
                      </button>
                      <button class="fc-button" type="button" onClick={() => run(() => props.bridge.cancelPairing())}>
                        {t("Cancel")}
                      </button>
                    </div>
                  </div>
                )}
              </Show>
            </section>
          </Show>

          <section class="fc-settings-section">
            <h3 class="fc-settings-title">{t("Paired devices")}</h3>
            <Show
              when={current().devices.length > 0}
              fallback={<p class="fc-settings-status">{t("No devices yet")}</p>}
            >
              <For each={current().devices}>
                {(device) => (
                  <div class="fc-mcp-row">
                    <span class="fc-mcp-name">{device.name}</span>
                    <span class="fc-status" classList={{ "fc-status-on": device.connected }}>
                      {device.connected ? t("Connected") : relativeTime(device.lastSeen)}
                    </span>
                    <Show when={device.notifications}>
                      <span class="fc-status" title={t("Notifications on")} aria-label={t("Notifications on")}>
                        🔔
                      </span>
                    </Show>
                    <button
                      class="fc-button fc-button-danger"
                      type="button"
                      onClick={() => run(() => props.bridge.revokeDevice(device.id))}
                    >
                      {t("Remove")}
                    </button>
                  </div>
                )}
              </For>
            </Show>
          </section>

          <details class="fc-remote-advanced">
            <summary>{t("Advanced")}</summary>
            <label class="fc-settings-row">
              <span>{t("Relay")}</span>
              <input
                class="fc-question-custom"
                value={relay()}
                spellcheck={false}
                onInput={(event) => setRelay(event.currentTarget.value)}
              />
            </label>
            <div class="fc-modal-links">
              <button class="fc-button" type="button" onClick={() => run(() => props.bridge.setRelay(relay()))}>
                {t("Save")}
              </button>
            </div>
            <Show when={!current().secureStorage}>
              <p class="fc-settings-status">
                {t("The system keychain is unavailable: device keys are stored unencrypted on disk.")}
              </p>
            </Show>
          </details>
        </>
      )}
    </Show>
  )
}

const ClientView: Component = () => {
  const statusLabel = () => {
    const status = remote.status()
    if (status === "connected") return t("Connected")
    if (status === "connecting") return t("Connecting")
    if (status === "reconnecting") return t("Reconnecting")
    if (status === "error") return t("Error")
    return t("Offline")
  }

  return (
    <>
      <Show when={remote.pairing()}>
        {(current) => (
          <section class="fc-settings-section" aria-live="polite">
            <Show
              when={current().error}
              fallback={<p class="fc-settings-status">{t("Pairing with {name}…", { name: current().name })}</p>}
            >
              {(code) => (
                <>
                  <p class="fc-remote-error">{t(ERRORS[code()])}</p>
                  <div class="fc-modal-links">
                    <button class="fc-button" type="button" onClick={() => remote.dismissPairing()}>
                      {t("Close")}
                    </button>
                  </div>
                </>
              )}
            </Show>
          </section>
        )}
      </Show>
      <p class="fc-modal-line">
        {t(
          "This browser is the remote control, not the controlled computer. The computer must have the FlupCode desktop app open with remote control turned on.",
        )}
      </p>
      <Show when={remote.activeHost()}>
        {(host) => (
          <section class="fc-settings-section">
            <div class="fc-settings-row">
              <span>{t("Connected to {name}", { name: host().name })}</span>
              <span
                class="fc-status"
                classList={{
                  "fc-status-on": remote.status() === "connected",
                  "fc-status-off": remote.status() === "error",
                }}
              >
                {statusLabel()}
              </span>
            </div>
            <Show when={remote.errorCode()}>{(code) => <p class="fc-settings-status">{t(ERRORS[code()])}</p>}</Show>
            <RemoteNotifications compact />
            <div class="fc-modal-links">
              <Show when={remote.status() !== "connected"}>
                <button class="fc-button" type="button" onClick={() => remote.retry()}>
                  {t("Retry")}
                </button>
              </Show>
              <button class="fc-button" type="button" onClick={() => remote.disconnect()}>
                {t("Disconnect")}
              </button>
            </div>
          </section>
        )}
      </Show>
      <Show when={!remote.activeHost() && remote.errorCode()}>
        {(code) => <p class="fc-settings-status">{t(ERRORS[code()])}</p>}
      </Show>
      <section class="fc-settings-section">
        <h3 class="fc-settings-title">{t("Paired computers")}</h3>
        <Show
          when={remote.hosts().length > 0}
          fallback={
            <>
              <p class="fc-settings-status">{t("No computers yet")}</p>
              <p class="fc-settings-status">
                {t(
                  "On the computer, open FlupCode → Remote control → Pair a device and scan the code with this device.",
                )}
              </p>
            </>
          }
        >
          <For each={remote.hosts()}>
            {(host) => (
              <div class="fc-mcp-row">
                <span class="fc-mcp-name">{host.name}</span>
                <Show when={remote.activeHost()?.hostId !== host.hostId}>
                  <button class="fc-button" type="button" onClick={() => remote.connect(host.hostId)}>
                    {t("Connect")}
                  </button>
                </Show>
                <button class="fc-button fc-button-danger" type="button" onClick={() => remote.forget(host.hostId)}>
                  {t("Forget")}
                </button>
              </div>
            )}
          </For>
        </Show>
      </section>
    </>
  )
}

const LocalNetwork: Component<{ open: boolean; initialUrl: string }> = (props) => {
  const [url, setUrl] = createSignal(props.initialUrl)
  const [svg, setSvg] = createSignal("")
  const [copied, setCopied] = createSignal<string>()

  const port = createMemo(() => enginePort(url()))
  const lan = createMemo(() => lanServeCommand(port(), window.location.origin))
  const tunnel = createMemo(() => tunnelCommand(port()))

  const copy = (text: string, what: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(what)
        setTimeout(() => setCopied((current) => (current === what ? undefined : current)), 2000)
      },
      () => toast(t("Could not copy"), "error"),
    )
  }

  createEffect(() => {
    if (!props.open) return
    const value = url().trim()
    if (!value) return setSvg("")
    void qr(value, 200).then(setSvg)
  })

  return (
    <details class="fc-remote-advanced">
      <summary>{t("Local network (without relay)")}</summary>
      <p class="fc-modal-line">{t("Open FlupCode on your phone by scanning the code.")}</p>
      <label class="fc-settings-row">
        <span>{t("URL")}</span>
        <input
          class="fc-question-custom"
          value={url()}
          spellcheck={false}
          onInput={(event) => setUrl(event.currentTarget.value)}
        />
      </label>
      <div class="fc-qr" innerHTML={svg()} />
      <div class="fc-modal-links">
        <button class="fc-button" type="button" onClick={() => void navigator.clipboard?.writeText(url())}>
          {t("Copy URL")}
        </button>
      </div>
      <p class="fc-modal-license">{t("To expose on the network:")}</p>
      <div class="fc-modal-links">
        <code class="fc-permission-pattern">{lan()}</code>
        <button class="fc-button" type="button" onClick={() => copy(lan(), "lan")}>
          {copied() === "lan" ? t("Copied") : t("Copy serve command")}
        </button>
      </div>
      <p class="fc-modal-license">{t("Or through a tunnel, without opening ports:")}</p>
      <div class="fc-modal-links">
        <code class="fc-permission-pattern">{tunnel()}</code>
        <button class="fc-button" type="button" onClick={() => copy(tunnel(), "tunnel")}>
          {copied() === "tunnel" ? t("Copied") : t("Copy tunnel command")}
        </button>
      </div>
    </details>
  )
}

export const RemotePanel: Component<RemotePanelProps> = (props) => {
  return (
    <Show when={props.open}>
      <div class="fc-modal-backdrop" onClick={props.onClose}>
        <div
          class="fc-modal fc-modal-wide"
          role="dialog"
          aria-modal="true"
          aria-label={t("Remote control")}
          onClick={(event) => event.stopPropagation()}
        >
          <div class="fc-modal-header">
            <span class="fc-modal-heading">
              <Show when={props.onBack}>
                <button class="fc-icon-button fc-back" type="button" aria-label={t("Back")} onClick={props.onBack}>
                  ←
                </button>
              </Show>
              <span>{t("Remote control")}</span>
            </span>
            <button class="fc-icon-button" type="button" aria-label={t("Close")} onClick={props.onClose}>
              ×
            </button>
          </div>
          <Show when={desktopRemote()} fallback={<ClientView />}>
            {(host) => <HostView bridge={host()} />}
          </Show>
          <LocalNetwork open={props.open} initialUrl={props.initialUrl} />
        </div>
      </div>
    </Show>
  )
}
