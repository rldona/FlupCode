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
  clearedSubagents: "flupcode.clearedSubagents",
  usageResetAt: "flupcode.usageResetAt",
  replySuggestions: "flupcode.replySuggestions",
  suggestionModel: "flupcode.suggestionModel",
  serverUrl: "flupcode.serverUrl",
  remoteHosts: "flupcode.remoteHosts",
  remoteActive: "flupcode.remoteActive",
  remotePush: "flupcode.remotePush",
  promptHistory: "flupcode.promptHistory",
  view: "flupcode.view",
  chatMode: "flupcode.chatMode",
  splitPanes: "flupcode.splitPanes",
  sessionTabs: "flupcode.sessionTabs",
  sessionTabsEnabled: "flupcode.sessionTabsEnabled",
  theme: "flupcode.theme",
  colorTheme: "flupcode.colorTheme",
  routines: "flupcode.routines",
  routinesMigration: "flupcode.routinesMigration",
  harnessServerUrl: "flupcode.harnessServerUrl",
  onboarded: "flupcode.onboarded",
  locale: "flupcode.locale",
  notifications: "flupcode.notifications",
  /** The editable shortcut map (H-24). `paletteKey` is the old single-key form, read for migration. */
  keybinds: "flupcode.keybinds",
  paletteKey: "flupcode.paletteKey",
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
