import { ComparePanel } from "../../components/ComparePanel"
import { useApp } from "../../app-context"

/** The comparison of two runs (H-33). */
export default function CompareRoute() {
  const app = useApp()
  return (
    <ComparePanel
      open={app.router.compareOpen()}
      runs={app.runs.runs()}
      initialLeft={app.router.compareArgs().left}
      initialRight={app.router.compareArgs().right}
      onLoad={app.runs.compareSnapshot}
    />
  )
}
