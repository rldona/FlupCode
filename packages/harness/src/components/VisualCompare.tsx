import { For, Show, createResource, onCleanup, type Component } from "solid-js"
import { t } from "../i18n"
import { openImagePreview } from "../image-preview"
import type { VisualShot } from "../types"

/**
 * What a verify task's look at the page found (CL-4): for each capture, the one the same step took
 * the time before, this one, and where they differ. A first capture has nothing before it and says
 * so; a page that did not hold still says that too, since its difference may be the motion.
 */
export const VisualCompare: Component<{
  shots: VisualShot[]
  /** An artifact's bytes as a blob URL, which this revokes when it goes. */
  rawArtifact: (id: string) => Promise<string>
}> = (props) => (
  <ul class="fc-visual-list">
    <For each={props.shots}>
      {(shot) => (
        <li class="fc-visual-shot" data-outcome={shot.outcome}>
          <p class="fc-visual-head">
            <span class="fc-visual-name">{shot.name}</span>
            <span class="fc-visual-outcome">{outcomeText(shot)}</span>
            <Show when={!shot.stable}>
              <span class="fc-run-meta">{t("It did not hold still")}</span>
            </Show>
          </p>
          <div class="fc-visual-pictures">
            <Show when={shot.before}>{(id) => <Picture id={id()} label={t("Before")} rawArtifact={props.rawArtifact} />}</Show>
            <Picture id={shot.after} label={t("After")} rawArtifact={props.rawArtifact} />
            <Show when={shot.diff}>{(id) => <Picture id={id()} label={t("Difference")} rawArtifact={props.rawArtifact} />}</Show>
          </div>
        </li>
      )}
    </For>
  </ul>
)

const Picture: Component<{ id: string; label: string; rawArtifact: (id: string) => Promise<string> }> = (props) => {
  const [url] = createResource(() => props.id, props.rawArtifact)
  onCleanup(() => {
    const current = url.latest
    if (current) URL.revokeObjectURL(current)
  })
  return (
    <figure class="fc-visual-picture">
      <Show when={url()} fallback={<div class="fc-visual-placeholder">{url.error ? t("Not available") : "…"}</div>}>
        {(src) => (
          <button class="fc-visual-open" type="button" onClick={() => openImagePreview({ uri: src(), name: props.label })}>
            <img src={src()} alt={props.label} />
          </button>
        )}
      </Show>
      <figcaption>{props.label}</figcaption>
    </figure>
  )
}

function outcomeText(shot: VisualShot) {
  if (shot.outcome === "first") return t("First capture: nothing to compare with yet")
  const share = `${(shot.changed * 100).toFixed(shot.changed > 0 && shot.changed < 0.001 ? 3 : 2)}%`
  if (shot.outcome === "same") return t("Same as before ({share} differs)", { share })
  return t("Changed: {share} of the page", { share })
}
