import { Menu, shell, type MenuItemConstructorOptions } from "electron"

type MenuHandlers = {
  onNewWindow: () => void
}

export function setApplicationMenu(handlers: MenuHandlers) {
  const isMac = process.platform === "darwin"

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" } as MenuItemConstructorOptions] : []),
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
        {
          label: "OpenHarness on GitHub",
          click: () => void shell.openExternal("https://github.com/rldona/OpenHarness"),
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
