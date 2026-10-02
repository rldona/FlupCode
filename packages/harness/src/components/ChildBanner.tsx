import { createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js"
import type { ChildState } from "@flupcode/remote/supervisor"
import { t } from "../i18n"

/**
 * The desktop app's engine and harness server, when one of them is not running (HE-03).
 *
 * While the supervisor restarts a child the banner says so and nothing is blocked: the app reconnects
 * on its own once the child answers. When the supervisor gave up, the banner names the reason and
 * offers to start it again or to copy the diagnostics for a bug report. Only the desktop app has a
 * supervisor; elsewhere this renders nothing.
 */
export const ChildBanner: Component<{ onRecovered: () => void; onTrouble: (troubled: boolean) => void }> = (props) => {
  const bridge = typeof window === "undefined" ? undefined : window.flupcode?.children
  const [children, setChildren] = createSignal<ChildState[]>([])
  const [copied, setCopied] = createSignal(false)
  const update = (states: ChildState[]) => {
    const wasDown = children().some((child) => child.phase === "restarting" || child.phase === "failed")
    setChildren(states)
    props.onTrouble(states.some((child) => child.phase === "restarting" || child.phase === "failed"))
    // Back up: the app asks again now rather than on its next poll.
    if (wasDown && states.every((child) => child.phase === "running")) props.onRecovered()
  }
  onMount(() => {
    if (!bridge) return
    void bridge.state().then(update)
    onCleanup(bridge.onChange(update))
  })
  const troubled = () => children().filter((child) => child.phase === "restarting" || child.phase === "failed")
  const copy = async () => {
    if (!(await bridge?.copyDiagnostics())) return
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    // Mounted only where a supervisor exists (the desktop app): a browser tab gets no extra live region.
    <Show when={bridge}>
      <p class="fc-sr-only" role="status" aria-live="polite">
        {troubled().map(childSentence).join(" ")}
      </p>
      <For each={troubled()}>
        {(child) => (
          <aside
            class="fc-child-banner"
            classList={{ "fc-child-banner-failed": child.phase === "failed" }}
            aria-label={childName(child.name)}
          >
            <span class="fc-child-banner-text">{childSentence(child)}</span>
            <Show when={child.phase === "failed"}>
              <button class="fc-button" type="button" onClick={() => void bridge?.restart(child.name)}>
                {t("Retry")}
              </button>
            </Show>
            <button class="fc-button" type="button" onClick={() => void copy()}>
              {copied() ? t("Copied") : t("Copy diagnostics")}
            </button>
          </aside>
        )}
      </For>
    </Show>
  )
}

function childName(name: string) {
  return name === "engine" ? t("The engine") : t("The harness server")
}

/** What the banner says about one child: restarting, or given up on and why. */
export function childSentence(child: ChildState) {
  const name = childName(child.name)
  if (child.phase === "restarting")
    return t("{name} stopped ({reason}) and is restarting…", { name, reason: child.failure?.message ?? "" })
  return t("{name} stopped and could not be restarted: {reason}", { name, reason: child.failure?.message ?? "" })
}
