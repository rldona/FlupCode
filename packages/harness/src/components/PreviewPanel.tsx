import { For, Show, createEffect, createSignal, on, onCleanup, type Component } from "solid-js"
import { createHarnessClient, type PreviewApproval } from "../client"
import type { ContextChip } from "../context-chip"
import { t } from "../i18n"
import type { DevServer, PreviewPage } from "../remote"
import { modalOpen } from "./Modal"
import { BrowserApprovalDock } from "./PermissionDock"

/** How often the empty state reads the servers listening on this machine. */
const SERVERS_POLL_MS = 3000
/** How often the panel checks that nothing covers the place the page is drawn in. */
const PLACE_POLL_MS = 250

type Mark = { x: number; y: number; width: number; height: number }

/**
 * The preview (BU-06): the project's dev server in the desktop app, next to the session.
 *
 * The page is not in this document. The desktop draws it in a view of its own over the panel's empty
 * box (`viewport`), and this panel keeps telling it where that box is; whenever something covers the
 * box (a dialog, a menu, the approval, annotating), the page is hidden so the app stays on top.
 *
 * Pages on this machine open by themselves. Anything else is the browser policy's to decide on the
 * server, and its question is asked here, with the same approval as the agent's browser. Annotating
 * takes a picture of the page, lets the reader mark areas on it and adds it to the composer as a chip.
 */
export const PreviewPanel: Component<{
  harnessServerUrl: string
  sessionID: string | undefined
  directory: string | undefined
  onAnnotate?: (chip: ContextChip) => void
}> = (props) => {
  const bridge = window.flupcode?.preview
  const client = () => createHarnessClient(props.harnessServerUrl)
  const [page, setPage] = createSignal<PreviewPage>()
  const [address, setAddress] = createSignal("")
  const [servers, setServers] = createSignal<DevServer[]>()
  const [approval, setApproval] = createSignal<PreviewApproval & { url: string }>()
  const [notice, setNotice] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [agent, setAgent] = createSignal(false)
  const [annotating, setAnnotating] = createSignal<{ image: string; marks: Mark[]; note: string }>()
  const [viewport, setViewport] = createSignal<HTMLDivElement>()

  const blank = () => !page()?.url || page()?.url === "about:blank"
  // The project's own servers first; without a folder, every server is someone else's.
  const ours = () => (servers() ?? []).filter((server) => server.inProject)
  const others = () => (servers() ?? []).filter((server) => !server.inProject)

  const report = (cause: unknown) => setNotice(cause instanceof Error ? cause.message : String(cause))

  /** A site off this machine: the server's policy opens it, or says what to ask. */
  const askServer = async (url: string) => {
    const result = await client()
      .preview.navigate(url, props.sessionID)
      .catch((cause: unknown) => {
        report(cause)
        return undefined
      })
    if (result && "approval" in result) setApproval({ ...result.approval, url })
  }

  const go = async (text: string) => {
    if (!bridge || !text.trim()) return
    setNotice("")
    setApproval(undefined)
    const opened = await bridge.open(text)
    if (opened.verdict === "refuse") return setNotice(t("The preview only opens web pages"))
    if (opened.verdict === "ask") await askServer(opened.url)
  }

  const answer = async (label: string) => {
    const asked = approval()
    const value = asked?.options.find((option) => option.label === label)?.value
    if (!asked || !value) return
    setBusy(true)
    await client()
      .preview.answer(asked.url, value, props.sessionID)
      .then(() => setApproval(undefined))
      .catch((cause: unknown) => {
        setApproval(undefined)
        report(cause)
      })
    setBusy(false)
  }

  // The page as the desktop reports it, and a link the page followed off this machine.
  if (bridge) {
    void bridge.state().then((state) => state && setPage(state))
    onCleanup(bridge.onChange(setPage))
    onCleanup(bridge.onBlocked((url) => void askServer(url)))
  }
  createEffect(
    on(
      () => page()?.url,
      (url) => {
        if (url && url !== "about:blank" && document.activeElement?.classList.contains("fc-preview-address") !== true)
          setAddress(url)
      },
    ),
  )

  // The servers on this machine, while there is no page to show.
  createEffect(() => {
    if (!bridge || !blank()) return
    const read = () =>
      void bridge
        .servers(props.directory)
        .then(setServers)
        .catch(() => setServers([]))
    read()
    const timer = setInterval(read, SERVERS_POLL_MS)
    onCleanup(() => clearInterval(timer))
  })

  // Whether the session's agent works in the preview.
  createEffect(() => {
    const sessionID = props.sessionID
    setAgent(false)
    if (!sessionID) return
    void client()
      .preview.agent(sessionID)
      .then((state) => setAgent(state.attached))
      .catch(() => undefined)
  })

  const toggleAgent = async () => {
    const sessionID = props.sessionID
    if (!sessionID || busy()) return
    setBusy(true)
    setNotice("")
    await (agent() ? client().preview.takeBack(sessionID) : client().preview.giveAgent(sessionID))
      .then((state) => setAgent(state.attached))
      .catch(report)
    setBusy(false)
  }

  // The desktop draws the page over the box; hidden whenever the box is covered or not in use.
  createEffect(() => {
    const box = viewport()
    if (!bridge || !box) return
    const shown = { last: "" }
    const place = () => {
      const rect = box.getBoundingClientRect()
      const covered =
        modalOpen() ||
        [
          [rect.left + rect.width / 2, rect.top + rect.height / 2],
          [rect.left + 4, rect.top + 4],
          [rect.right - 4, rect.top + 4],
          [rect.left + 4, rect.bottom - 4],
          [rect.right - 4, rect.bottom - 4],
        ].some(([x, y]) => !box.contains(document.elementFromPoint(x!, y!)))
      const visible = !blank() && !approval() && !annotating() && !covered && rect.width > 0 && rect.height > 0
      const key = visible ? [rect.left, rect.top, rect.width, rect.height].map(Math.round).join(",") : "hidden"
      if (key === shown.last) return
      shown.last = key
      if (!visible) return void bridge.hide()
      void bridge.show({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(box)
    const timer = setInterval(place, PLACE_POLL_MS)
    window.addEventListener("resize", place)
    onCleanup(() => {
      observer.disconnect()
      clearInterval(timer)
      window.removeEventListener("resize", place)
      void bridge.hide()
    })
  })

  const startAnnotating = async () => {
    if (!bridge) return
    setNotice("")
    const image = await bridge.capture()
    if (!image) return setNotice(t("Could not take a picture of the page"))
    setAnnotating({ image, marks: [], note: "" })
  }

  const finishAnnotating = async () => {
    const current = annotating()
    const shown = page()
    if (!current || !shown) return
    setBusy(true)
    const image = await marked(current.image, current.marks)
    const label = labelOf(shown.url)
    const stored = await client()
      .preview.annotate({
        image,
        title: t("Preview annotation: {page}", { page: shown.title || label }),
        ...(props.sessionID ? { sessionID: props.sessionID } : {}),
      })
      .catch(() => undefined)
    props.onAnnotate?.({
      id: crypto.randomUUID(),
      type: "preview",
      label,
      source: shown.url,
      image,
      ...(stored ? { artifactID: stored.artifactID } : {}),
      ...(current.note.trim() ? { note: current.note.trim() } : {}),
    })
    setBusy(false)
    setAnnotating(undefined)
  }

  return (
    <div class="fc-panel-body fc-preview">
      <Show
        when={bridge}
        fallback={
          <div class="fc-empty-state">
            <span class="fc-empty-title">{t("The preview is only in the desktop app")}</span>
          </div>
        }
      >
        {(preview) => (
          <>
            <form
              class="fc-preview-bar"
              onSubmit={(event) => {
                event.preventDefault()
                void go(address())
              }}
            >
              <button
                class="fc-icon-button"
                type="button"
                aria-label={t("Back")}
                title={t("Back")}
                disabled={!page()?.canGoBack}
                onClick={() => void preview().history("back")}
              >
                ←
              </button>
              <button
                class="fc-icon-button"
                type="button"
                aria-label={t("Forward")}
                title={t("Forward")}
                disabled={!page()?.canGoForward}
                onClick={() => void preview().history("forward")}
              >
                →
              </button>
              <button
                class="fc-icon-button"
                type="button"
                aria-label={t("Reload")}
                title={t("Reload")}
                disabled={blank()}
                onClick={() => void preview().history("reload")}
              >
                ↻
              </button>
              <input
                class="fc-question-custom fc-preview-address"
                type="text"
                spellcheck={false}
                placeholder="localhost:5173"
                aria-label={t("Address")}
                value={address()}
                onInput={(event) => setAddress(event.currentTarget.value)}
              />
            </form>
            <div class="fc-preview-actions">
              <Show when={!blank()}>
                <button class="fc-button" type="button" disabled={!!annotating()} onClick={() => void startAnnotating()}>
                  {t("Annotate")}
                </button>
                <button class="fc-button" type="button" onClick={() => void preview().history("close")}>
                  {t("Running servers")}
                </button>
              </Show>
              <Show when={props.sessionID}>
                <button
                  class="fc-button"
                  classList={{ "fc-button-primary": agent() }}
                  type="button"
                  disabled={busy()}
                  aria-pressed={agent()}
                  onClick={() => void toggleAgent()}
                >
                  {agent() ? t("Take the preview back") : t("Give the agent the preview")}
                </button>
              </Show>
            </div>
            <Show when={approval()}>
              {(asked) => (
                <BrowserApprovalDock
                  approval={{ ...asked(), action: asked().action ?? "preview.navigate", preview: true }}
                  busy={busy()}
                  onAnswer={(label) => void answer(label)}
                />
              )}
            </Show>
            <Show when={notice()}>
              <p class="fc-preview-notice" role="status">
                {notice()}
              </p>
            </Show>
            <Show when={annotating()}>
              {(current) => (
                <Annotator
                  image={current().image}
                  marks={current().marks}
                  note={current().note}
                  busy={busy()}
                  onMarks={(marks) => setAnnotating({ ...current(), marks })}
                  onNote={(note) => setAnnotating({ ...current(), note })}
                  onCancel={() => setAnnotating(undefined)}
                  onDone={() => void finishAnnotating()}
                />
              )}
            </Show>
            <div class="fc-preview-viewport" classList={{ "fc-preview-hidden": !!annotating() }} ref={setViewport}>
              <Show when={blank()}>
                <div class="fc-empty-state fc-preview-empty">
                  <span class="fc-empty-title">
                    {props.directory ? t("Running from this project") : t("Running on this machine")}
                  </span>
                  <Show when={servers() !== undefined} fallback={<span class="fc-empty-hint">{t("Loading…")}</span>}>
                    <Show
                      when={ours().length > 0}
                      fallback={
                        <span class="fc-empty-hint">
                          {props.directory
                            ? t("No web server started from this project. Start your dev server and it appears here.")
                            : t("No web server is running. Start your dev server and it appears here.")}
                        </span>
                      }
                    >
                      <ServerList servers={ours()} onOpen={(url) => void go(url)} />
                    </Show>
                    {/* Everything else listening here: other projects, other apps. Out of the way, still one click. */}
                    <Show when={others().length > 0}>
                      <details class="fc-preview-others">
                        <summary>{t("Other servers on this machine ({n})", { n: others().length })}</summary>
                        <ServerList servers={others()} onOpen={(url) => void go(url)} />
                      </details>
                    </Show>
                  </Show>
                  <span class="fc-empty-hint">
                    {t("Pages on this machine open here; any other site asks first.")}
                  </span>
                </div>
              </Show>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}

const ServerList: Component<{ servers: DevServer[]; onOpen: (url: string) => void }> = (props) => (
  <ul class="fc-preview-servers">
    <For each={props.servers}>
      {(server) => (
        <li>
          <button class="fc-preview-server" type="button" title={server.cwd ?? server.url} onClick={() => props.onOpen(server.url)}>
            <span class="fc-preview-server-port">:{server.port}</span>
            <span class="fc-preview-server-name">
              {server.title ?? server.process ?? server.url}
              <Show when={server.title && server.process}>
                <span class="fc-preview-server-process"> · {server.process}</span>
              </Show>
            </span>
          </button>
        </li>
      )}
    </For>
  </ul>
)

/** Marking areas on a picture of the page: drag to draw a box, each one numbered, and a note. */
const Annotator: Component<{
  image: string
  marks: Mark[]
  note: string
  busy: boolean
  onMarks: (marks: Mark[]) => void
  onNote: (note: string) => void
  onCancel: () => void
  onDone: () => void
}> = (props) => {
  const [drawing, setDrawing] = createSignal<Mark>()
  const fraction = (event: PointerEvent, box: HTMLElement) => {
    const rect = box.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    }
  }
  const shown = () => [...props.marks, ...(drawing() ? [drawing()!] : [])]
  return (
    <div class="fc-preview-annotate">
      <p class="fc-empty-hint">{t("Drag over the page to mark what you mean.")}</p>
      <div
        class="fc-preview-annotate-canvas"
        onPointerDown={(event) => {
          const box = event.currentTarget
          box.setPointerCapture(event.pointerId)
          const start = fraction(event, box)
          setDrawing({ ...start, width: 0, height: 0 })
          const move = (moved: PointerEvent) => {
            const at = fraction(moved, box)
            setDrawing({
              x: Math.min(start.x, at.x),
              y: Math.min(start.y, at.y),
              width: Math.abs(at.x - start.x),
              height: Math.abs(at.y - start.y),
            })
          }
          const up = () => {
            box.removeEventListener("pointermove", move)
            box.removeEventListener("pointerup", up)
            const mark = drawing()
            setDrawing(undefined)
            // A click is not a mark: too small to point at anything.
            if (mark && mark.width > 0.01 && mark.height > 0.01) props.onMarks([...props.marks, mark])
          }
          box.addEventListener("pointermove", move)
          box.addEventListener("pointerup", up)
        }}
      >
        <img src={props.image} alt={t("The page in the preview")} draggable={false} />
        <For each={shown()}>
          {(mark, index) => (
            <span
              class="fc-preview-mark"
              style={{
                left: `${mark.x * 100}%`,
                top: `${mark.y * 100}%`,
                width: `${mark.width * 100}%`,
                height: `${mark.height * 100}%`,
              }}
            >
              <span class="fc-preview-mark-number">{index() + 1}</span>
            </span>
          )}
        </For>
      </div>
      <textarea
        class="fc-question-custom fc-preview-note"
        rows={2}
        placeholder={t("What should change here?")}
        value={props.note}
        onInput={(event) => props.onNote(event.currentTarget.value)}
      />
      <div class="fc-preview-annotate-actions">
        <button class="fc-button" type="button" disabled={props.marks.length === 0} onClick={() => props.onMarks(props.marks.slice(0, -1))}>
          {t("Undo")}
        </button>
        <button class="fc-button" type="button" onClick={() => props.onCancel()}>
          {t("Cancel")}
        </button>
        <button class="fc-button fc-button-primary" type="button" disabled={props.busy} onClick={() => props.onDone()}>
          {t("Add to the message")}
        </button>
      </div>
    </div>
  )
}

/** The page's address as a chip names it: host and path. */
const labelOf = (url: string) => (URL.canParse(url) ? `${new URL(url).host}${new URL(url).pathname.replace(/\/$/, "")}` : url)

/** The picture with its marks drawn in, numbered as the reader saw them. */
async function marked(image: string, marks: Mark[]) {
  if (marks.length === 0) return image
  const picture = new Image()
  picture.src = image
  await picture.decode()
  const canvas = document.createElement("canvas")
  canvas.width = picture.naturalWidth
  canvas.height = picture.naturalHeight
  const context = canvas.getContext("2d")
  if (!context) return image
  context.drawImage(picture, 0, 0)
  // One colour that reads on any page, whatever the app's theme: the marks are drawn on the site.
  const color = "#e11d48"
  const scale = Math.max(1, canvas.width / 800)
  marks.forEach((mark, index) => {
    const box = { x: mark.x * canvas.width, y: mark.y * canvas.height, width: mark.width * canvas.width, height: mark.height * canvas.height }
    context.strokeStyle = color
    context.lineWidth = 3 * scale
    context.strokeRect(box.x, box.y, box.width, box.height)
    const radius = 11 * scale
    context.fillStyle = color
    context.beginPath()
    context.arc(box.x, box.y, radius, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = "white"
    context.font = `bold ${13 * scale}px sans-serif`
    context.textAlign = "center"
    context.textBaseline = "middle"
    context.fillText(String(index + 1), box.x, box.y)
  })
  return canvas.toDataURL("image/png")
}
