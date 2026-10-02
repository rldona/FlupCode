import { AgentsPanel } from "../../components/AgentsPanel"
import { useApp } from "../../app-context"

/** The agents screen (H-13). */
export default function AgentsRoute() {
  const app = useApp()
  return (
    <AgentsPanel
      open={app.router.agentsOpen()}
      files={app.catalog.agentFiles() ?? []}
      agents={app.catalog.folderAgents() ?? []}
      tools={app.catalog.engineTools() ?? []}
      mcp={app.catalog.mcp()?.data ?? []}
      models={app.catalog.modelList()}
      favorites={app.settings.favorites()}
      onToggleFavorite={app.settings.toggleFavoriteModel}
      loading={app.catalog.agentFiles.loading}
      serverAvailable={app.runs.routinesServerAvailable()}
      hasProject={!!app.sessions.vcsDirectory()}
      onSave={app.catalog.saveAgent}
      onDelete={app.catalog.deleteAgent}
    />
  )
}
