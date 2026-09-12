import { createSignal, type Component } from "solid-js"

type OnboardingProps = {
  open: boolean
  serverHealthy: boolean | undefined
  onDone: (name: string) => void
}

export const Onboarding: Component<OnboardingProps> = (props) => {
  const [name, setName] = createSignal("")
  if (!props.open) return null

  return (
    <div class="fc-modal-backdrop">
      <div class="fc-modal fc-modal-wide" role="dialog" aria-modal="true">
        <div class="fc-onboarding">
          <span class="fc-onboarding-logo">FlupCode</span>
          <h2 class="fc-onboarding-title">Bienvenido a FlupCode</h2>
          <p class="fc-onboarding-text">
            Un harness para OpenCode con dashboard, rutinas y proyectos, en web y escritorio.
          </p>

          <div class="fc-onboarding-status" classList={{ "fc-onboarding-status-off": props.serverHealthy === false }}>
            {props.serverHealthy === undefined
              ? "Comprobando el servidor…"
              : props.serverHealthy
                ? "Servidor conectado"
                : "Sin conexión al servidor"}
          </div>

          <label class="fc-settings-row">
            <span>¿Cómo te llamas?</span>
            <input
              class="fc-question-custom"
              value={name()}
              placeholder="Tu nombre"
              onInput={(event) => setName(event.currentTarget.value)}
            />
          </label>

          <button class="fc-button fc-button-primary" type="button" onClick={() => props.onDone(name())}>
            Empezar
          </button>
        </div>
      </div>
    </div>
  )
}
