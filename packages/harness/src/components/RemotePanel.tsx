import { createEffect, createSignal, type Component } from "solid-js"
import QRCode from "qrcode"

type RemotePanelProps = {
  open: boolean
  initialUrl: string
  onClose: () => void
}

export const RemotePanel: Component<RemotePanelProps> = (props) => {
  const [url, setUrl] = createSignal(props.initialUrl)
  const [svg, setSvg] = createSignal("")

  createEffect(() => {
    if (!props.open) return
    const value = url().trim()
    if (!value) {
      setSvg("")
      return
    }
    void QRCode.toString(value, { type: "svg", margin: 1, width: 200 })
      .then(setSvg)
      .catch(() => setSvg(""))
  })

  if (!props.open) return null

  return (
    <div class="fc-modal-backdrop" onClick={props.onClose}>
      <div class="fc-modal fc-modal-wide" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div class="fc-modal-header">
          <span>Acceso remoto / móvil</span>
          <button class="fc-icon-button" type="button" aria-label="Cerrar" onClick={props.onClose}>
            ×
          </button>
        </div>
        <p class="fc-modal-line">Abre FlupCode desde el móvil escaneando el código.</p>
        <label class="fc-settings-row">
          <span>URL</span>
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
            Copiar URL
          </button>
        </div>
        <p class="fc-modal-license">
          Para exponerlo en la red: OPENCODE_SERVER_PASSWORD=… opencode serve --hostname 0.0.0.0 --port 4096
        </p>
      </div>
    </div>
  )
}
