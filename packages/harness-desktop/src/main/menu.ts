import { Menu, shell, type MenuItemConstructorOptions } from "electron"

type MenuHandlers = {
  onNewWindow: () => void
  onCheckUpdates: () => void
}

export function setApplicationMenu(handlers: MenuHandlers) {
  const isMac = process.platform === "darwin"

  const template: MenuItemConstructorOptions[] = [
    // The app menu is written out rather than taken from its role: on macOS an update check belongs
    // under About, which is where anyone looks for it, and a role menu has no room for it.
    ...(isMac
      ? [
          {
            label: "FlupCode",
            submenu: [
              { role: "about" },
              { label: "Check for Updates…", click: () => handlers.onCheckUpdates() },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: [
        { label: "New Window", accelerator: "CmdOrCtrl+N", click: () => handlers.onNewWindow() },
        ...(isMac ? [] : [{ role: "quit" } as MenuItemConstructorOptions]),
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        // Windows and Linux have no app menu, so the check lives here for them.
        ...(isMac
          ? []
          : [
              { label: "Check for Updates…", click: () => handlers.onCheckUpdates() } as MenuItemConstructorOptions,
              { type: "separator" } as MenuItemConstructorOptions,
            ]),
        {
          label: "FlupCode on GitHub",
          click: () => void shell.openExternal("https://github.com/rldona/FlupCode"),
        },
        {
          label: "Upstream OpenCode",
          click: () => void shell.openExternal("https://github.com/anomalyco/opencode"),
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
