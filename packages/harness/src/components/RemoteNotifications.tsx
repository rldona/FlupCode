import { Match, Switch, type Component } from "solid-js"
import { t } from "../i18n"
import { pushBusy, pushStatus } from "../push"
import { remote } from "../remote"
import { toast } from "../toast"

/** Turns remote control notifications on or off, or explains why they are not available. */
export const RemoteNotifications: Component<{ compact?: boolean }> = (props) => {
  const run = (work: () => Promise<void>) =>
    void work().catch((cause: unknown) => toast(cause instanceof Error ? cause.message : String(cause), "error"))

  return (
    <Switch>
      <Match when={pushStatus() === "off"}>
        <div class="fc-remote-notify" classList={{ "fc-remote-notify-compact": props.compact }}>
          <span class="fc-remote-card-main">
            <span class="fc-remote-card-title">{t("Get notified")}</span>
            <span class="fc-remote-card-meta fc-remote-notify-text">
              {t("When a session needs your permission, has a question or finishes.")}
            </span>
          </span>
          <button
            class="fc-button fc-button-primary"
            type="button"
            disabled={pushBusy() || remote.status() !== "connected"}
            onClick={() => run(() => remote.enableNotifications())}
          >
            {t("Turn on")}
          </button>
        </div>
      </Match>
      <Match when={pushStatus() === "on"}>
        <div class="fc-remote-notify fc-remote-notify-compact">
          <span class="fc-remote-card-main">
            <span class="fc-remote-card-title">{t("Notifications on")}</span>
          </span>
          <button class="fc-button" type="button" onClick={() => run(() => remote.disableNotifications())}>
            {t("Turn off")}
          </button>
        </div>
      </Match>
      <Match when={pushStatus() === "blocked"}>
        <p class="fc-remote-empty">
          {t("Notifications are blocked for this site. Allow them in the browser's site settings.")}
        </p>
      </Match>
      <Match when={pushStatus() === "install"}>
        <p class="fc-remote-empty">
          {t(
            "To get notifications on iPhone, add FlupCode to the Home Screen (Share → Add to Home Screen) and open it from there.",
          )}
        </p>
      </Match>
    </Switch>
  )
}
