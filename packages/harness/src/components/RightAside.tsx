import { For, Show, type Component } from "solid-js"
import { MemoryInspector } from "./MemoryInspector"
import { SubagentList } from "./SubagentList"
import { SIDEBAR_WIDTH_DEFAULT } from "./Sidebar"
import type { SessionInfo } from "../engine-types"
import { t } from "../i18n"
import { cssPx } from "../text-size"

type RightAsideProps = {
  /** This session's child sessions, if it has spawned any. */
  subagents: SessionInfo[] | undefined
  /** Hides listed children by their session id. */
  onClearSubagents: (ids: string[]) => void
  onOpenSubagent: (id: string) => void
  /** Which of those the engine is working on, and which are waiting on a permission. */
  runningSubagents: string[]
  blockedSubagents: string[]
  width: number
  onResize: (width: number) => void
  /** Dragging the edge almost to the window's right side hides the panel. */
  onHide: () => void
  serverUrl: string
  sessionID?: string
}

/** Same width as the left sidebar, so both panels read as a pair. */
export const CONTEXT_PANEL_WIDTH = { min: 240, max: 560, default: SIDEBAR_WIDTH_DEFAULT }

export const RightAside: Component<RightAsideProps> = (props) => {
  return (
    <aside class="fc-rightaside" style={{ width: `${props.width}px` }}>
      <div
        class="fc-rightaside-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("Resize context panel")}
        title={t("Drag to resize, double-click to reset")}
        onDblClick={() => props.onResize(CONTEXT_PANEL_WIDTH.default)}
        onPointerDown={(event) => {
          const target = event.currentTarget
          const right = target.parentElement!.getBoundingClientRect().right
          const startWidth = props.width
          target.setPointerCapture(event.pointerId)
          const move = (moveEvent: PointerEvent) => {
            const width = cssPx(right - moveEvent.clientX)
            if (width < CONTEXT_PANEL_WIDTH.min - 80) {
              stop()
              // Reopening restores the width from before this drag.
              props.onResize(startWidth)
              props.onHide()
              return
            }
            props.onResize(width)
          }
          const stop = () => {
            if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
            target.removeEventListener("pointermove", move)
            target.removeEventListener("pointerup", stop)
          }
          target.addEventListener("pointermove", move)
          target.addEventListener("pointerup", stop)
        }}
      />
      <div class="fc-rightaside-body">
        <SubagentList
          sessions={props.subagents}
          onOpen={props.onOpenSubagent}
          onClear={props.onClearSubagents}
          running={props.runningSubagents}
          blocked={props.blockedSubagents}
        />

        <MemoryInspector serverUrl={props.serverUrl} sessionID={props.sessionID} />
      </div>
    </aside>
  )
}
