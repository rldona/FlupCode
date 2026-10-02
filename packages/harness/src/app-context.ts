import { createContext, useContext } from "solid-js"
import type { CatalogStore } from "./features/catalog/store"
import type { ComposerStore } from "./features/composer/store"
import type { ConnectionStore } from "./features/connection/store"
import type { RunsStore } from "./features/runs/store"
import type { EngineEventsStore } from "./features/sessions/events"
import type { SessionsStore } from "./features/sessions/store"
import type { SettingsStore } from "./features/settings/store"
import type { WorkspaceStore } from "./features/workspace/store"
import type { RouterStore } from "./router"

/**
 * The app's state, one store per feature. Every store is handed the whole set, so a feature reads
 * another's state where it needs it (`app.sessions.selected()`) instead of having it passed down.
 */
export type AppStores = {
  connection: ConnectionStore
  router: RouterStore
  settings: SettingsStore
  sessions: SessionsStore
  events: EngineEventsStore
  runs: RunsStore
  catalog: CatalogStore
  workspace: WorkspaceStore
  composer: ComposerStore
}

export const AppContext = createContext<AppStores>()

/** The stores, for a component rendered inside the app. */
export function useApp() {
  const app = useContext(AppContext)
  if (!app) throw new Error("useApp is only available inside the app")
  return app
}
