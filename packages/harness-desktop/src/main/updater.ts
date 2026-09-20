import { app, dialog } from "electron"
import { autoUpdater } from "electron-updater"

export function initAutoUpdate() {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on("error", (error) => {
    dialog.showErrorBox("Actualización", error.message)
  })

  autoUpdater.on("update-downloaded", (info) => {
    void dialog
      .showMessageBox({
        type: "question",
        buttons: ["Reiniciar ahora", "Más tarde"],
        defaultId: 0,
        message: `FlupCode ${info.version} está listo.`,
        detail: "Reinicia para instalar la actualización.",
      })
      .then((result) => {
        if (result.response === 0) autoUpdater.quitAndInstall()
      })
  })
}

export async function checkForUpdates() {
  if (!app.isPackaged) {
    dialog.showMessageBox({ message: "Las actualizaciones solo están disponibles en la app instalada." })
    return
  }
  try {
    await autoUpdater.checkForUpdatesAndNotify()
  } catch (error) {
    dialog.showErrorBox("Actualización", error instanceof Error ? error.message : String(error))
  }
}
