import { For, Show, onCleanup, type Component } from "solid-js"
import { t } from "../i18n"
import { createHarnessClient } from "../client"
import { UNKNOWN } from "../cost"
import { formatDateTime } from "../dates"
import { createResource } from "../resource"
import { forecastText, headlineWindow, usedShare, windowName, windowValue } from "../quota"
import { PanelFailure } from "./PanelBoundary"
import type { ProviderQuota, QuotaWindow } from "../types"

/**
 * The connected providers' quotas on the Cost screen (UL-07): what each provider reports of its own
 * limits, read by harness-server every few minutes, with a pace and a forecast from the readings it
 * kept. Collapsed, a provider shows its shortest window; open, every window.
 *
 * This is the provider's word on the key, all of its use and not only FlupCode's, so it is never
 * added to the ledger's money above.
 */
export const QuotasBlock: Component<{ serverUrl: string; serverAvailable: boolean }> = (props) => {
  const [quotas, { refetch }] = createResource(
    () => props.serverAvailable && props.serverUrl,
    (url) => createHarnessClient(url).quotas(),
  )
  // The server reads providers on its own schedule; the screen only re-reads what it kept.
  const timer = setInterval(() => void refetch(), 60_000)
  onCleanup(() => clearInterval(timer))

  return (
    <section class="fc-usage-block" aria-labelledby="fc-usage-quotas">
      <h2 id="fc-usage-quotas">{t("Provider quotas")}</h2>
      <p class="fc-usage-note">
        {t("What each connected provider reports of its own limits for the key, all of its use and not only FlupCode's. Read every few minutes by the server; the key stays in the engine.")}
      </p>
      <Show when={quotas.failure()}>
        {(error) => (
          <PanelFailure
            inline
            title={
              quotas()
                ? t("Refresh failed: these are the last figures read.")
                : t("{name} could not be read", { name: t("Provider quotas") })
            }
            error={error()}
            onRetry={() => void refetch()}
          />
        )}
      </Show>
      <Show when={quotas() && quotas()!.length === 0}>
        <p class="fc-usage-note">
          {t("No connected provider reports its quota. FlupCode reads it for OpenRouter and DeepSeek API keys.")}
        </p>
      </Show>
      <div class="fc-quota-list">
        <For each={quotas() ?? []}>{(quota) => <ProviderRow quota={quota} />}</For>
      </div>
    </section>
  )
}

const ProviderRow: Component<{ quota: ProviderQuota }> = (props) => {
  const headline = () => headlineWindow(props.quota.windows)
  return (
    <details class="fc-quota">
      <summary class="fc-quota-summary">
        <span class="fc-quota-name">{props.quota.name}</span>
        <Show when={headline()} fallback={<span class="fc-quota-headline">{UNKNOWN}</span>}>
          {(window) => (
            <span class="fc-quota-headline">
              {windowName(window())}: {windowValue(window())}
            </span>
          )}
        </Show>
        <span class="fc-quota-read">
          {props.quota.sampledAt !== null
            ? t("Read {when}", { when: formatDateTime(props.quota.sampledAt) })
            : t("Not read yet")}
        </span>
        <Show when={props.quota.error}>
          <span class="fc-quota-failed">{t("Refresh failed")}</span>
        </Show>
      </summary>
      <Show when={props.quota.error}>
        {(error) => (
          <p class="fc-quota-error">
            {props.quota.sampledAt !== null
              ? t("Refresh failed: these are the last figures read.")
              : t("Refresh failed")}{" "}
            {error().message} · {formatDateTime(error().at)}
          </p>
        )}
      </Show>
      <For each={props.quota.windows}>{(window) => <WindowRow window={window} />}</For>
      <a class="fc-link fc-quota-docs" href={props.quota.docs} target="_blank" rel="noreferrer">
        {t("What the provider reports")}
      </a>
    </details>
  )
}

const WindowRow: Component<{ window: QuotaWindow }> = (props) => (
  <div class="fc-quota-window">
    <span class="fc-quota-window-name">{windowName(props.window)}</span>
    {/* A meter only against a limit: an empty track beside a balance would read as nothing used. */}
    <Show when={usedShare(props.window) !== undefined} fallback={<span aria-hidden="true" />}>
      <span class="fc-usage-bar" aria-hidden="true">
        <span style={{ width: `${usedShare(props.window)}%` }} />
      </span>
    </Show>
    <span class="fc-quota-window-value">{windowValue(props.window)}</span>
    <span class="fc-quota-window-note">
      <Show when={props.window.resetAt !== null}>{t("Resets {when}", { when: formatDateTime(props.window.resetAt!) })} · </Show>
      {forecastText(props.window)}
    </span>
  </div>
)
