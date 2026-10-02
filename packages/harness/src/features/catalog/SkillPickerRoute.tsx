import { SkillsPanel } from "../../components/SkillsPanel"
import { useApp } from "../../app-context"

/** The skill picker that puts a skill in the composer. */
export default function SkillPickerRoute() {
  const app = useApp()
  return (
    <SkillsPanel
      open={app.router.skillsOpen()}
      skills={app.catalog.skills()?.data ?? []}
      onInsert={(name) => {
        app.composer.setPrompt(`/${name} `)
        app.router.setSkillsOpen(false)
      }}
      onClose={() => app.router.setSkillsOpen(false)}
    />
  )
}
