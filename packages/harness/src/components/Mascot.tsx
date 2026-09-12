import { createSignal, type Component } from "solid-js"

export const Mascot: Component<{ class?: string; state?: string }> = (props) => {
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
      <img class="fc-mascot-image" src={`/flup_${props.state ?? "idle"}.gif`} alt="" draggable={false} />
    </button>
  )
}
