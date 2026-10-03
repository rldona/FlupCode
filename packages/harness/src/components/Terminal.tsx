import { Show, createSignal, onCleanup, onMount, type Component } from "solid-js"
import { Terminal as XTerm } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
import { createClient } from "../client"
import { t } from "../i18n"
import { PanelFailure } from "./PanelBoundary"

type TerminalPanelProps = {
  serverUrl: string
  directory?: string
}

/** How many times a lost connection is reopened on its own before the reader is asked. */
const RECONNECTS = 3

/**
 * A shell on the engine's machine, on OpenCode 2's PTY (TI-04).
 *
 * Everything engine-shaped — the routes, the connect ticket, the frames — is the adapter's
 * (`engine.pty`); this draws the terminal and keeps it connected. A lost socket is reopened against
 * the same PTY a few times, from a cleared screen because the engine replays what it printed; past
 * that, or when the PTY cannot be made at all, the panel says so in a sentence with a way to retry.
 */
export const TerminalPanel: Component<TerminalPanelProps> = (props) => {
  let container: HTMLDivElement | undefined
  let term: XTerm | undefined
  let fit: FitAddon | undefined
  let stream: { send: (data: string) => void; close: () => void } | undefined
  let ptyID: string | undefined
  // What was typed while no stream was open (the first connect, a reconnect): sent once one is.
  let pending = ""
  let disposed = false
  const [failure, setFailure] = createSignal<Error>()

  const engine = () => createClient(props.serverUrl).pty

  const sendSize = () => {
    if (!ptyID || !term?.cols || !term.rows) return
    void engine()
      .resize(ptyID, { rows: term.rows, cols: term.cols }, props.directory)
      .catch(() => undefined)
  }

  const connect = async (attempt = 0): Promise<void> => {
    try {
      ptyID ??= await engine().create(props.directory)
      if (disposed) return
      term?.reset()
      stream = await engine().connect({
        id: ptyID,
        directory: props.directory,
        onOutput: (data) => term?.write(data),
        // A dropped socket is reopened after a pause, so a PTY that keeps closing cannot spin.
        onClose: () => {
          stream = undefined
          if (!disposed) setTimeout(() => void connect(), 500)
        },
      })
      if (disposed) return stream.close()
      if (pending) stream.send(pending)
      pending = ""
      setFailure(undefined)
      sendSize()
      term?.focus()
    } catch (cause) {
      if (disposed) return
      if (attempt < RECONNECTS && ptyID) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
        return connect(attempt + 1)
      }
      // The PTY is gone or never was: Retry makes a new one.
      ptyID = undefined
      setFailure(cause instanceof Error ? cause : new Error(String(cause)))
    }
  }

  // xterm needs concrete colours, so read the palette tokens the app already applies to <html>.
  const xtermTheme = () => {
    const styles = getComputedStyle(document.documentElement)
    return {
      background: styles.getPropertyValue("--fc-terminal-bg").trim(),
      foreground: styles.getPropertyValue("--fc-terminal-fg").trim(),
    }
  }

  onMount(() => {
    if (!container) return
    // The terminal draws on a canvas, so it takes its type from the tokens rather than from CSS.
    const styles = getComputedStyle(document.documentElement)
    term = new XTerm({
      convertEol: true,
      cursorBlink: true,
      fontSize: parseFloat(styles.getPropertyValue("--fc-text-sm")),
      fontFamily: styles.getPropertyValue("--fc-font-mono").trim(),
      theme: xtermTheme(),
    })
    // The mode class and the palette attribute are the app's only signals for a theme change.
    const themeObserver = new MutationObserver(() => {
      if (term) term.options.theme = xtermTheme()
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-fc-theme"] })
    fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    queueMicrotask(() => fit?.fit())

    const observer = new ResizeObserver(() => fit?.fit())
    observer.observe(container)
    term.onResize(() => sendSize())
    term.onData((data) => {
      if (stream) return stream.send(data)
      pending += data
    })
    void connect()

    onCleanup(() => {
      disposed = true
      observer.disconnect()
      themeObserver.disconnect()
      stream?.close()
      if (ptyID) void engine().remove(ptyID, props.directory).catch(() => undefined)
      term?.dispose()
    })
  })

  return (
    <>
      <Show when={failure()}>
        {(error) => (
          <PanelFailure
            title={t("The terminal could not connect to the engine")}
            error={error()}
            onRetry={() => {
              setFailure(undefined)
              void connect()
            }}
          />
        )}
      </Show>
      <div class="fc-terminal" classList={{ "fc-terminal-failed": !!failure() }} ref={container} />
    </>
  )
}
