import { For, Show, createEffect, createSignal, onCleanup, onMount, type Component } from "solid-js"
import { t } from "../i18n"
import { createResource } from "../resource"
import { createHarnessClient } from "../client"
import { toast } from "../toast"
import { holdModalFocus } from "../modal-focus"
import type { SessionAdaptiveOverride, SessionTurnSummary } from "../types"

type AdaptiveChipProps = {
  serverUrl: string
  sessionID: string
  /** The session is generating: the turn is re-read when it starts and ends, never on a timer. */
  busy: boolean
  /** Opens the Decisions screen on one decision ("Why?"). */
  onWhy: (decisionID: string) => void
}

/** The chip's own words: it says "paused" in the row itself, so a pause is never out of sight. */
export const chipLabel = (override: SessionAdaptiveOverride | undefined) =>
  override?.paused ? t("Adaptive · paused") : t("Adaptive")

/** What the context plan did this turn: saved tokens when it applied, would have saved when only observed. */
export function planText(plan: SessionTurnSummary["plan"]): string {
  if (!plan) return t("No context plan this turn")
  const tokens = plan.tokensSaved.toLocaleString()
  return plan.applied
    ? t("Context plan applied: −{tokens} tokens", { tokens })
    : t("Context plan observed: would save {tokens} tokens", { tokens })
}

/** The decision "Why?" opens: the skill suggestion first, then the plan's, then the model's. */
export const whyDecision = (summary: SessionTurnSummary | undefined) =>
  summary?.relevance?.decisionID ?? summary?.plan?.decisionID ?? summary?.model?.decisionID

/** The exclusion list with one skill added or taken out, without repeats. */
export const excludedWith = (override: SessionAdaptiveOverride, skill: string, excluded: boolean) =>
  excluded
    ? [...new Set([...override.excludedSkills, skill])]
    : override.excludedSkills.filter((name) => name !== skill)

/**
 * The composer's "Adaptive" chip (AH-E02).
 *
 * The in-session surface of the adaptive layer: what it did on the latest turn — the skills it
 * suggested, the context plan and what it saved, the predictive model and how long it took — and the
 * two escape hatches that act on this session only: pause everything, or stop suggesting one skill.
 * Both are in-memory overrides on the harness server, so nothing is written to the user's config and a
 * restart forgets them. "Why?" opens the decision behind the turn in the Decisions screen.
 */
export const AdaptiveChip: Component<AdaptiveChipProps> = (props) => {
  const [open, setOpen] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [reads, setReads] = createSignal(0)
  let root: HTMLDivElement | undefined
  let button: HTMLButtonElement | undefined

  const [summary, actions] = createResource(
    () => ({ url: props.serverUrl, sessionID: props.sessionID, busy: props.busy, reads: reads() }),
    (input) => createHarnessClient(input.url).adaptive.sessions.turn(input.sessionID),
  )
  // The previous session's answer never speaks for this one while the next read is in flight.
  const current = () => (summary()?.sessionID === props.sessionID ? summary() : undefined)

  createEffect(() => {
    props.sessionID
    setOpen(false)
  })

  onMount(() => {
    const onDocClick = (event: MouseEvent) => {
      if (root && !root.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDocClick)
    onCleanup(() => document.removeEventListener("mousedown", onDocClick))
  })

  const write = (patch: Partial<SessionAdaptiveOverride>) => {
    setSaving(true)
    void createHarnessClient(props.serverUrl)
      .adaptive.sessions.setOverride(props.sessionID, patch)
      .then((override) => {
        const value = current()
        if (value) actions.mutate({ ...value, override })
      })
      .catch((cause: unknown) =>
        toast(t("Could not change the adaptive layer for this session"), "error", {
          description: cause instanceof Error ? cause.message : String(cause),
        }),
      )
      .finally(() => setSaving(false))
  }

  const override = () => current()?.override ?? { paused: false, excludedSkills: [] }

  return (
    <div
      class="fc-mode fc-adaptive-chip"
      classList={{ "fc-adaptive-chip-paused": override().paused }}
      ref={root}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open()) return
        setOpen(false)
        button?.focus()
      }}
    >
      <button
        ref={button}
        class="fc-mode-button"
        type="button"
        aria-expanded={open()}
        aria-haspopup="dialog"
        title={t("What the adaptive layer did on this turn")}
        onClick={() => {
          if (!open()) setReads((value) => value + 1)
          setOpen((value) => !value)
        }}
      >
        {chipLabel(current()?.override)}
        <span class="fc-mode-caret">▾</span>
      </button>
      <Show when={open()}>
        <div
          ref={(node) => onCleanup(holdModalFocus(node))}
          class="fc-mode-popover fc-adaptive-popover"
          role="dialog"
          aria-label={t("Adaptive on this turn")}
          tabIndex={-1}
        >
          <div class="fc-mode-title">{t("This turn")}</div>
          {/* Always mounted, so pausing or resuming (an answer that arrives later) is read out. */}
          <div role="status">
            <Show when={override().paused}>
              <p class="fc-adaptive-note">
                {t(
                  "Paused in this session: from the next step nothing adaptive acts, and each decision is recorded as paused.",
                )}
              </p>
            </Show>
          </div>
          <Show when={summary.failure() && !current()}>
            <p class="fc-adaptive-note">{t("The adaptive summary is not available right now.")}</p>
          </Show>

          <section class="fc-adaptive-section" aria-label={t("Suggested skills")}>
            <div class="fc-adaptive-label">{t("Suggested skills")}</div>
            <Show
              when={(current()?.relevance?.skills.length ?? 0) > 0}
              fallback={<p class="fc-adaptive-muted">{t("No skills suggested")}</p>}
            >
              <Show when={current()?.relevance && !current()!.relevance!.acted}>
                <p class="fc-adaptive-muted">{t("Recorded only: no skill line was added to the prompt.")}</p>
              </Show>
              <For each={current()!.relevance!.skills}>
                {(skill) => (
                  <div class="fc-adaptive-row">
                    <span class="fc-adaptive-skill">{skill}</span>
                    <Show when={!override().excludedSkills.includes(skill)}>
                      <button
                        class="fc-button fc-adaptive-action"
                        type="button"
                        disabled={saving()}
                        onClick={() => write({ excludedSkills: excludedWith(override(), skill, true) })}
                      >
                        {t("Don't suggest {skill}", { skill })}
                      </button>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </section>

          <Show when={override().excludedSkills.length > 0}>
            <section class="fc-adaptive-section" aria-label={t("Not suggested in this session")}>
              <div class="fc-adaptive-label">{t("Not suggested in this session")}</div>
              <For each={override().excludedSkills}>
                {(skill) => (
                  <div class="fc-adaptive-row">
                    <span class="fc-adaptive-skill">{skill}</span>
                    <button
                      class="fc-button fc-adaptive-action"
                      type="button"
                      disabled={saving()}
                      onClick={() => write({ excludedSkills: excludedWith(override(), skill, false) })}
                    >
                      {t("Suggest {skill} again", { skill })}
                    </button>
                  </div>
                )}
              </For>
            </section>
          </Show>

          <section class="fc-adaptive-section" aria-label={t("Context")}>
            <div class="fc-adaptive-label">{t("Context")}</div>
            <p class="fc-adaptive-muted">{planText(current()?.plan)}</p>
          </section>

          <Show when={current()?.model}>
            {(model) => (
              <section class="fc-adaptive-section" aria-label={t("Predictive model")}>
                <div class="fc-adaptive-label">{t("Predictive model")}</div>
                <p class="fc-adaptive-muted">
                  {t("Consulted {model} ({latency} ms)", {
                    model: model().providerID,
                    latency: String(model().latencyMs),
                  })}
                </p>
              </section>
            )}
          </Show>

          <div class="fc-adaptive-actions">
            <button
              class="fc-button"
              type="button"
              disabled={saving() || !current()}
              onClick={() => write({ paused: !override().paused })}
            >
              {override().paused ? t("Resume in this session") : t("Pause in this session")}
            </button>
            <button
              class="fc-button"
              type="button"
              disabled={!whyDecision(current())}
              onClick={() => {
                const id = whyDecision(current())
                if (!id) return
                setOpen(false)
                props.onWhy(id)
              }}
            >
              {t("Why?")}
            </button>
          </div>
        </div>
      </Show>
    </div>
  )
}
