import { Show } from "solid-js"
import { SkillCatalogue } from "../../components/SkillCatalogue"
import { t } from "../../i18n"
import { canOpenLocalFiles, openInEditor } from "../../remote"
import { PanelBoundary } from "../../components/PanelBoundary"
import { useApp } from "../../app-context"

/** The skills screen (H-27). */
export default function SkillsRoute() {
  const app = useApp()
  return (
    <Show when={app.router.skillsScreenOpen()}>
      <PanelBoundary name={t("The skills screen")}>
        <SkillCatalogue
          open={app.router.skillsScreenOpen()}
          files={app.catalog.skillFiles() ?? []}
          skills={app.catalog.skills()?.data ?? []}
          loading={app.catalog.skillFiles.loading}
          skillsLoading={app.catalog.skills.loading}
          serverAvailable={app.runs.routinesServerAvailable()}
          hasProject={!!app.sessions.vcsDirectory()}
          serverUrl={app.connection.harnessServerUrl()}
          projectID={app.sessions.vcsDirectory()}
          capabilities={app.connection.harnessCapabilities()}
          canOpenFiles={canOpenLocalFiles()}
          onOpenInEditor={(path) => void openInEditor(path)}
          sources={app.catalog.skillSources()}
          agents={app.catalog.agentFiles() ?? []}
          onAddSource={app.catalog.addSkillSource}
          onRemoveSource={app.catalog.removeSkillSource}
          onRead={app.catalog.readSkillFile}
          onSave={app.catalog.saveSkill}
          onDelete={app.catalog.deleteSkillFile}
        />
      </PanelBoundary>
    </Show>
  )
}
