import { Show } from "solid-js"
import { t } from "../../i18n"
import { ChildBanner } from "../../components/ChildBanner"
import { remote } from "../../remote"
import { useApp } from "../../app-context"

/** What the app says about its connection to the engine, above whatever is on screen. */
export function Banners() {
  const app = useApp()
  return (
    <>
      <Show when={app.connection.historyImport()}>
        {(status) => (
          <div class="fc-offline-banner fc-history-import" role="status">
            <span>
              {(() => {
                const current = status()
                if (current.status === "error")
                  return t("OpenCode 2 could not import the 1.x history: {error}", { error: current.error })
                if (current.status !== "running") return ""
                const progress = current.progress
                return `${t("Importing your OpenCode 1.x history…")} ${progress.label}${progress.denominator ? ` ${progress.numerator ?? 0}/${progress.denominator}` : ""}`
              })()}
            </span>
          </div>
        )}
      </Show>
      <ChildBanner onRecovered={() => void app.connection.refetchHealth()} onTrouble={app.connection.setChildTrouble} />
      <Show
        when={
          app.settings.onboarded() &&
          !remote.activeHost() &&
          app.connection.localNetworkReady() &&
          !app.connection.health.loading &&
          app.connection.health()?.healthy !== true &&
          // The desktop's own banner already says the engine is restarting, and why.
          !app.connection.childTrouble()
        }
      >
        <div class="fc-offline-banner">
          <Show
            when={app.connection.localNetworkAsking()}
            fallback={
              <>
                <Show
                  when={app.connection.serverAuthRequired()}
                  fallback={
                    <Show
                      when={app.connection.health()?.legacy}
                      fallback={
                        <span>
                          {app.connection.health()?.blocked
                            ? t("Connection blocked by the browser")
                            : t("Server offline")}{" "}
                          — {t("start it, or open the desktop app")} ·{" "}
                          {/* Blocked means something answers but not for this page: name it on the allowed list. */}
                          <code>
                            {app.connection.health()?.blocked
                              ? `FLUPCODE_WEB_ORIGINS=${window.location.origin} flupcode serve`
                              : "flupcode serve"}
                          </code>
                        </span>
                      }
                    >
                      <span>
                        {t("This engine is OpenCode 1.x, which FlupCode no longer supports")} —{" "}
                        {t("stop it and run flupcode serve, or open FlupCode's desktop app")} ·{" "}
                        <code>flupcode serve</code>
                      </span>
                    </Show>
                  }
                >
                  <span>
                    {t(
                      "This engine is OpenCode 2, which always asks for a password, and a browser page has no way to send one",
                    )}{" "}
                    — {t("stop it and run flupcode serve, or open FlupCode's desktop app: both sign this page in")}
                  </span>
                </Show>
                <button class="fc-button" type="button" onClick={() => void app.connection.refetchHealth()}>
                  {t("Retry")}
                </button>
              </>
            }
          >
            <span>
              {app.connection.localNetwork() === "denied"
                ? t(
                    "Local network access is blocked for this site. Allow it in your browser's site settings, then try again.",
                  )
                : t("This web page needs your permission to reach the engine on this device before it can connect.")}
            </span>
            <Show when={app.connection.localNetwork() !== "denied"}>
              <button
                class="fc-button fc-button-primary"
                type="button"
                disabled={app.connection.allowingLocalNetwork()}
                onClick={() => void app.connection.allowLocalNetwork()}
              >
                {app.connection.allowingLocalNetwork() ? t("Asking…") : t("Allow access")}
              </button>
            </Show>
            <button class="fc-button" type="button" onClick={() => void app.connection.refetchHealth()}>
              {t("Retry")}
            </button>
          </Show>
        </div>
      </Show>
    </>
  )
}
