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
        <div class="fc-panel-error" role="alert">
          <span class="fc-panel-error-title">{t("{name} could not be shown", { name: props.name })}</span>
          <span class="fc-panel-error-detail">
            {errorDetail(error instanceof Error ? error.message : String(error))}
          </span>
          <button class="fc-button" type="button" onClick={reset}>
            {t("Try again")}
          </button>
        </div>
      )
    }}
  >
    {props.children}
  </ErrorBoundary>
)
