import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, type Component } from "solid-js"
import { t } from "../i18n"
import { describeReplayEvent, replayCounts, replaySeq, replayTime, type ReplayEvent } from "../replay"

type ReplayPage = { data: ReplayEvent[]; hasMore: boolean }

type ReplayPanelProps = {
  open: boolean
  sessionID?: string
  title?: string
  /** One page of durable events after a sequence; the same call the replay itself uses (H-33). */
  onPage: (after?: number) => Promise<ReplayPage>
  onClose: () => void
}

const clock = (ms: number | undefined) => (ms === undefined ? "" : new Date(ms).toLocaleTimeString())

/**
 * A session, event by event (H-33).
 *
 * The engine's durable events are what a run looked like while it happened, and reading them back in
 * order answers questions the final transcript cannot — what was retried, which model answered, when
 * a compaction landed. The scrubber walks the sequence; the summary says what is in it at a glance.
 */
export const ReplayPanel: Component<ReplayPanelProps> = (props) => {
  const [events, setEvents] = createSignal<ReplayEvent[]>([])
  const [hasMore, setHasMore] = createSignal(false)
  const [cursor, setCursor] = createSignal(0)
  const [loading, setLoading] = createSignal(false)
  const [playing, setPlaying] = createSignal(false)
  const [problem, setProblem] = createSignal<string>()

  const shown = createMemo(() => events().slice(0, cursor()))
  const counts = createMemo(() => replayCounts(events()))

  const load = async (after?: number) => {
    setLoading(true)
    setProblem(undefined)
    try {
      const page = await props.onPage(after)
      if (after === undefined) {
        setEvents(page.data)
        // Start at the end: the replay opens on what happened, and the scrubber walks back.
        setCursor(page.data.length)
      } else {
        const current = events()
        setEvents([...current, ...page.data])
        // Only follow along if the reader was already at the end.
        if (cursor() >= current.length) setCursor(current.length + page.data.length)
      }
      setHasMore(page.hasMore)
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  createEffect(
    on(
      () => [props.open, props.sessionID] as const,
      ([open]) => {
        if (!open) return
        setEvents([])
        setCursor(0)
        setPlaying(false)
        void load()
      },
    ),
  )

  createEffect(() => {
    if (!playing()) return
    const timer = setInterval(() => {
      setCursor((current) => {
        if (current >= events().length) {
          setPlaying(false)
          return current
        }
        return current + 1
      })
    }, 220)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <Show when={props.open}>
      <section class="fc-routines-screen" aria-label={t("Replay")}>
        <div class="fc-routines-header">
          <div>
            <div class="fc-routines-kicker">{t("Session OS")}</div>
            <h1>{t("Replay")}</h1>
            <p>{props.title ?? t("What this session did, event by event.")}</p>
          </div>
          <div class="fc-routines-header-actions">
            <button class="fc-button" type="button" onClick={props.onClose}>
              {t("Back to sessions")}
            </button>
          </div>
        </div>

        <Show when={problem()}>{(text) => <p class="fc-run-error">{text()}</p>}</Show>

        <Show when={events().length > 0} fallback={<p class="fc-usage-note">{loading() ? t("Reading…") : t("No events yet.")}</p>}>
          <section class="fc-usage-block">
            <h2>
              {t("What is in it")}
              <span class="fc-context-aside">{events().length}</span>
            </h2>
            <div class="fc-replay-counts">
              <For each={counts()}>
                {(entry) => (
                  <span class="fc-replay-count">
                    <b>{t(entry.label)}</b> {entry.count}
                  </span>
                )}
              </For>
            </div>
          </section>

          <section class="fc-usage-block">
            <h2>{t("Step through it")}</h2>
            <div class="fc-replay-controls">
              <button class="fc-button" type="button" onClick={() => setPlaying((value) => !value)}>
                {playing() ? t("Pause") : t("Play")}
              </button>
              <input
                class="fc-replay-range"
                type="range"
                min="0"
                max={events().length}
                value={cursor()}
                aria-label={t("Event")}
                onInput={(event) => {
                  setPlaying(false)
                  setCursor(Number(event.currentTarget.value))
                }}
              />
              <span class="fc-replay-position">
                {cursor()} / {events().length}
              </span>
              <Show when={hasMore()}>
                <button
                  class="fc-button"
                  type="button"
                  disabled={loading()}
                  onClick={() => {
                    const last = events().at(-1)
                    void load(replaySeq(last ?? {}) ?? events().length)
                  }}
                >
                  {t("Load more")}
                </button>
              </Show>
            </div>

            <ol class="fc-replay-log">
              <For each={shown()}>
                {(event, index) => {
                  const described = describeReplayEvent(event)
                  return (
                    <li class="fc-replay-event" classList={{ "fc-replay-event-last": index() === shown().length - 1 }}>
                      <span class="fc-replay-seq">{replaySeq(event) ?? "-"}</span>
                      <span class="fc-replay-time">{clock(replayTime(event))}</span>
                      <span class="fc-replay-label">{t(described.label)}</span>
                      <Show when={described.detail}>{(detail) => <bdi class="fc-replay-detail">{detail()}</bdi>}</Show>
                    </li>
                  )
                }}
              </For>
            </ol>
          </section>
        </Show>
      </section>
    </Show>
  )
}
