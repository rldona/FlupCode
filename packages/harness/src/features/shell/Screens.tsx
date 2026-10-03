import { For, Show, createMemo, lazy, type Component } from "solid-js"
import type { Screen } from "../../screen"
import { useApp } from "../../app-context"

/**
 * The tool screens that live in the main column (HF-9), in the order they were always drawn. Each one
 * is its own chunk, loaded the first time it is opened.
 */
const SCREENS: Array<[Screen, Component]> = [
  ["runs", lazy(() => import("../runs/RunsRoute"))],
  ["changes", lazy(() => import("../workspace/ChangesRoute"))],
  ["workflows", lazy(() => import("../runs/WorkflowsRoute"))],
  ["artifacts", lazy(() => import("../workspace/ArtifactsRoute"))],
  ["compare", lazy(() => import("../runs/CompareRoute"))],
  ["routines", lazy(() => import("../runs/RoutinesRoute"))],
  ["actions", lazy(() => import("../runs/ActionsRoute"))],
  ["context", lazy(() => import("../workspace/ContextRoute"))],
  ["decisions", lazy(() => import("../insights/DecisionsRoute"))],
  ["skills", lazy(() => import("../catalog/SkillsRoute"))],
  ["cost", lazy(() => import("../insights/UsageRoute"))],
]

/**
 * The tool screens. One that was opened stays mounted until the reader leaves the tool screens, as
 * when they were all mounted together: going from Runs to Changes and back finds Runs as it was.
 */
export function Screens() {
  const app = useApp()
  const visited = createMemo<Screen[]>((previous) => {
    if (!app.router.toolScreen()) return []
    const screen = app.router.screen()
    return screen && !previous.includes(screen) ? [...previous, screen] : previous
  }, [])
  return (
    <Show when={app.router.toolScreen()}>
      <For each={SCREENS}>
        {([screen, Route]) => (
          <Show when={visited().includes(screen)}>
            <Route />
          </Show>
        )}
      </For>
    </Show>
  )
}
