import { ErrorBoundary, type JSX, type Component } from "solid-js"
import { t } from "../i18n"
import { errorDetail } from "../error-text"

/**
 * A region that fails on its own. Without one of these, a render error anywhere — a malformed tool
 * payload, a diff the highlighter chokes on — reaches the root boundary and replaces the whole app
 * with the startup error screen, losing the session the reader was in.
 */
export const PanelBoundary: Component<{ name: string; children: JSX.Element }> = (props) => (
  <ErrorBoundary
    fallback={(error, reset) => {
      console.error(`${props.name} panel failed`, error)
      return (
        <PanelFailure
          title={t("{name} could not be shown", { name: props.name })}
          error={error instanceof Error ? error : new Error(String(error))}
          onRetry={reset}
        />
      )
    }}
  >
    {props.children}
  </ErrorBoundary>
)

/**
 * A failure said where the answer would have been, with a way to ask again. Used for a read that
 * failed as well as for a region that could not render, so both look and recover the same way.
 */
export const PanelFailure: Component<{ title: string; error: Error; onRetry: () => void; inline?: boolean }> = (
  props,
) => (
  <div class="fc-panel-error" classList={{ "fc-panel-error-inline": props.inline }} role="alert">
    <span class="fc-panel-error-title">{props.title}</span>
    <span class="fc-panel-error-detail">{failureDetail(props.error)}</span>
    <button class="fc-button" type="button" onClick={props.onRetry}>
      {t("Try again")}
    </button>
  </div>
)

/**
 * What a failed read says to the reader. A harness `403 invalid_token` is not a server that is down
 * but a page without the loopback token, so it is named as such (TI-14).
 */
export function failureDetail(error: Error) {
  if ("code" in error && error.code === "invalid_token")
    return t("The harness server refused this page: it needs the desktop app or a paired device.")
  return errorDetail(error.message)
}
