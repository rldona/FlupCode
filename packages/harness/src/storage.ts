export function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function writeStorage(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    return
  }
}

export const STORAGE_KEYS = {
  pinnedProjects: "flupcode.pinnedProjects",
  displayName: "flupcode.displayName",
  sidebarCollapsed: "flupcode.sidebarCollapsed",
  contextPanelHidden: "flupcode.contextPanelHidden",
  contextPanelWidth: "flupcode.contextPanelWidth",
  appTextSize: "flupcode.appTextSize",
  chatTextSize: "flupcode.chatTextSize",
  clearedTodos: "flupcode.clearedTodos",
  usageResetAt: "flupcode.usageResetAt",
  replySuggestions: "flupcode.replySuggestions",
  suggestionModel: "flupcode.suggestionModel",
  serverUrl: "flupcode.serverUrl",
  remoteHosts: "flupcode.remoteHosts",
  remoteActive: "flupcode.remoteActive",
  remotePush: "flupcode.remotePush",
  stashedPrompts: "flupcode.stashedPrompts",
  promptHistory: "flupcode.promptHistory",
  view: "flupcode.view",
  splitPanes: "flupcode.splitPanes",
  theme: "flupcode.theme",
  colorTheme: "flupcode.colorTheme",
  routines: "flupcode.routines",
  routinesMigration: "flupcode.routinesMigration",
  harnessServerUrl: "flupcode.harnessServerUrl",
  onboarded: "flupcode.onboarded",
  locale: "flupcode.locale",
  notifications: "flupcode.notifications",
  paletteKey: "flupcode.paletteKey",
  pinnedSessions: "flupcode.pinnedSessions",
  expandedProjects: "flupcode.expandedProjects",
  sidebarWidth: "flupcode.sidebarWidth",
  agent: "flupcode.agent",
  workspacePanels: "flupcode.workspacePanels",
  workspaceWidth: "flupcode.workspaceWidth",
  favoriteModels: "flupcode.favoriteModels",
  permissionMode: "flupcode.permissionMode",
  delivery: "flupcode.delivery",
  showReasoning: "flupcode.showReasoning",
  selectedSession: "flupcode.selectedSession",
  selectedModel: "flupcode.selectedModel",
  confirmModelSwitch: "flupcode.confirmModelSwitch",
  noFolderSessions: "flupcode.noFolderSessions",
} as const
