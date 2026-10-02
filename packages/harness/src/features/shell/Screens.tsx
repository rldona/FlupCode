import { Show } from "solid-js"
import { useApp } from "../../app-context"
import RunsRoute from "../runs/RunsRoute"
import ChangesRoute from "../workspace/ChangesRoute"
import WorkflowsRoute from "../runs/WorkflowsRoute"
import ArtifactsRoute from "../workspace/ArtifactsRoute"
import CompareRoute from "../runs/CompareRoute"
import RoutinesRoute from "../runs/RoutinesRoute"
import ActionsRoute from "../runs/ActionsRoute"
import ContextRoute from "../workspace/ContextRoute"
import DecisionsRoute from "../insights/DecisionsRoute"
import AgentsRoute from "../catalog/AgentsRoute"
import SkillsRoute from "../catalog/SkillsRoute"
import UsageRoute from "../insights/UsageRoute"

/** The tool screens that live in the main column (HF-9), each drawn by its own route. */
export function Screens() {
  const app = useApp()
  return (
    <Show when={app.router.toolScreen()}>
      <RunsRoute />
      <ChangesRoute />
      <WorkflowsRoute />
      <ArtifactsRoute />
      <CompareRoute />
      <RoutinesRoute />
      <ActionsRoute />
      <ContextRoute />
      <DecisionsRoute />
      <AgentsRoute />
      <SkillsRoute />
      <UsageRoute />
    </Show>
  )
}
