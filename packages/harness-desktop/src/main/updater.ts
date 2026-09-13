import { app, dialog } from "electron"
import electronUpdater from "electron-updater"

const { autoUpdater } = electronUpdater

let manual = false
let started = false

export function initAutoUpdate() {
  if (!app.isPackaged || started) return
  started = true

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on("error", (error) => {
    if (!manual) return
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

  const check = () => void autoUpdater.checkForUpdatesAndNotify().catch(() => undefined)
  setTimeout(check, 15000)
  setInterval(check, 6 * 60 * 60 * 1000)
}

export async function checkForUpdates() {
  if (!app.isPackaged) {
    dialog.showMessageBox({ message: "Las actualizaciones solo están disponibles en la app instalada." })
    return
  }
  manual = true
  try {
    await autoUpdater.checkForUpdatesAndNotify()
  } catch (error) {
    dialog.showErrorBox("Actualización", error instanceof Error ? error.message : String(error))
  } finally {
    manual = false
  }
}
