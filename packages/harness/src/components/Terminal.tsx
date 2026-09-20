import { onCleanup, onMount, type Component } from "solid-js"
import { Terminal as XTerm } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
import type { EngineSocket } from "@flupcode/remote"
import { engineFetch, engineSocket } from "../transport"

type TerminalPanelProps = {
  serverUrl: string
  directory?: string
}

export const TerminalPanel: Component<TerminalPanelProps> = (props) => {
  let container: HTMLDivElement | undefined
  let term: XTerm | undefined
  let fit: FitAddon | undefined
  let socket: EngineSocket | undefined
  let ptyID: string | undefined
  let disposed = false

  const base = () => props.serverUrl.replace(/\/$/, "")
  const query = () => (props.directory ? `?directory=${encodeURIComponent(props.directory)}` : "")

  const sendSize = () => {
    if (!ptyID) return
    const cols = term?.cols
    const rows = term?.rows
    if (!cols || !rows) return
    void engineFetch(`${base()}/pty/${ptyID}${query()}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ size: { rows, cols } }),
    }).catch(() => undefined)
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
    term = new XTerm({
      convertEol: true,
      cursorBlink: true,
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
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
    queueMicrotask(() => {
      fit?.fit()
      sendSize()
    })

    const observer = new ResizeObserver(() => {
      fit?.fit()
      sendSize()
    })
    observer.observe(container)

    term.onData((data) => {
      if (socket?.readyState === 1) socket.send(data)
    })

    void (async () => {
      try {
        const created = (await engineFetch(`${base()}/pty${query()}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...(props.directory ? { cwd: props.directory } : {}) }),
        }).then((response) => response.json())) as { id?: string }
        if (disposed) return
        if (!created.id) throw new Error("PTY session could not be created")
        ptyID = created.id
        const socketUrl = `${base().replace(/^http/, "ws")}/pty/${ptyID}/connect${query()}`
        socket = engineSocket(socketUrl)
        socket.binaryType = "arraybuffer"
        socket.onopen = () => {
          sendSize()
          term?.focus()
        }
        socket.onmessage = (event) => {
          if (typeof event.data === "string") {
            term?.write(event.data)
            return
          }
          const bytes = new Uint8Array(event.data as ArrayBuffer)
          if (bytes[0] === 0) return
          term?.write(bytes)
        }
        socket.onclose = () => {
          if (!disposed) term?.write("\r\n[disconnected]\r\n")
        }
      } catch (error) {
        term?.write(`\r\n[terminal error] ${error instanceof Error ? error.message : String(error)}\r\n`)
      }
    })()

    onCleanup(() => {
      disposed = true
      observer.disconnect()
      themeObserver.disconnect()
      socket?.close()
      if (ptyID) void engineFetch(`${base()}/pty/${ptyID}${query()}`, { method: "DELETE" }).catch(() => undefined)
      term?.dispose()
    })
  })

  return <div class="fc-terminal" ref={container} />
}
