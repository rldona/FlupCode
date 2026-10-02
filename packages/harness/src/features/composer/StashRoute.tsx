import { StashDialog } from "../../components/StashDialog"
import { useApp } from "../../app-context"

/** The prompts set aside (H-18). */
export default function StashRoute() {
  const app = useApp()
  return (
    <StashDialog
      open={app.router.stashOpen()}
      items={app.composer.stashes()}
      onRestore={app.composer.restoreStash}
      onRemove={app.composer.removeStash}
      onClose={() => app.router.setStashOpen(false)}
    />
  )
}
