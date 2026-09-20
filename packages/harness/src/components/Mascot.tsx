import { createSignal, type Component } from "solid-js"

export const Mascot: Component<{ class?: string }> = (props) => {
  const [play, setPlay] = createSignal(false)

  const trigger = () => {
    setPlay(false)
    requestAnimationFrame(() => {
      setPlay(true)
      window.setTimeout(() => setPlay(false), 900)
    })
  }

  return (
    <button
      class={`fc-mascot ${props.class ?? ""}`}
      classList={{ "fc-mascot-play": play() }}
      type="button"
      aria-label="Flup"
      onClick={trigger}
    >
      <svg viewBox="0 0 32 26" width="34" height="28" aria-hidden="true">
        <line x1="16" y1="1" x2="16" y2="6" stroke="var(--fc-accent)" stroke-width="2" stroke-linecap="round" />
        <circle cx="16" cy="1.5" r="1.6" fill="var(--fc-accent)" />
        <rect x="7" y="6" width="18" height="13" rx="4.5" fill="var(--fc-accent)" />
        <rect x="11" y="10.5" width="3" height="3.4" rx="1" fill="#241812" />
        <rect x="18" y="10.5" width="3" height="3.4" rx="1" fill="#241812" />
        <path d="M12 15.5h8" stroke="#241812" stroke-width="1.4" stroke-linecap="round" />
        <rect x="9" y="19" width="4" height="5" rx="1.4" fill="var(--fc-accent)" />
        <rect x="19" y="19" width="4" height="5" rx="1.4" fill="var(--fc-accent)" />
      </svg>
    </button>
  )
}
