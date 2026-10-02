import { BestOfNDialog } from "../../components/BestOfNDialog"
import { useApp } from "../../app-context"

/** One task, several models (H-44). */
export default function BestOfNRoute() {
  const app = useApp()
  return (
    <BestOfNDialog
      open={app.router.bestOfNOpen()}
      models={app.catalog.modelList()}
      loading={app.catalog.models.loading}
      favorites={app.settings.favorites()}
      onLaunch={app.runs.launchBestOfN}
      onClose={() => app.router.setBestOfNOpen(false)}
    />
  )
}
