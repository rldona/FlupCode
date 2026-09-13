import { spawn, spawnSync } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { dirname, resolve } from "node:path"
import { app, dialog, shell } from "electron"
import electronUpdater from "electron-updater"

const { autoUpdater } = electronUpdater

const RELEASES_URL = "https://github.com/rldona/FlupCode/releases/latest"

let manual = false
let started = false
/** The downloaded zip, installed on quit when the user chose "Later" (self-installing Macs only). */
let pendingZip: string | undefined
let installing = false

/** The running `.app` bundle on macOS. */
const appBundle = () => resolve(app.getPath("exe"), "..", "..", "..")

/**
 * Squirrel.Mac only installs an update whose signature matches the running app. Builds without a
 * Developer ID (ad-hoc or unsigned, F5-4) never match, so those Macs replace the bundle themselves.
 */
function selfInstallsOnMac() {
  if (process.platform !== "darwin") return false
  const result = spawnSync("codesign", ["-dv", appBundle()], { encoding: "utf8" })
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
  return result.status !== 0 || /Signature=adhoc|not signed/.test(output)
}

/** Whether the bundle can be replaced in place (not translocated, folder writable). */
function canReplaceBundle(bundle: string) {
  if (!bundle.endsWith(".app") || bundle.includes("/AppTranslocation/")) return false
  try {
    accessSync(dirname(bundle), constants.W_OK)
    accessSync(bundle, constants.W_OK)
    return true
  } catch {
    return false
  }
}

// Runs detached after FlupCode exits: unpack the downloaded zip, swap the bundle (restoring the old
// one if the copy fails), clear quarantine and optionally reopen.
const INSTALL_SCRIPT = `
pid="$1"; zip="$2"; target="$3"; reopen="$4"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
work="$(/usr/bin/mktemp -d)" || exit 1
trap 'rm -rf "$work"' EXIT
/usr/bin/ditto -x -k "$zip" "$work" || exit 1
next="$(/usr/bin/find "$work" -maxdepth 1 -name '*.app' -print -quit)"
[ -n "$next" ] || exit 1
backup="$target.previous-$$"
mv "$target" "$backup" || exit 1
if /usr/bin/ditto "$next" "$target"; then
  rm -rf "$backup"
else
  rm -rf "$target"
  mv "$backup" "$target"
fi
/usr/bin/xattr -dr com.apple.quarantine "$target" 2>/dev/null
[ "$reopen" = "1" ] && /usr/bin/open "$target"
exit 0
`

function installOnMac(zip: string, reopen: boolean) {
  const bundle = appBundle()
  if (!canReplaceBundle(bundle)) {
    pendingZip = undefined
    // Quitting: no dialog, the next start offers the update again.
    if (!reopen) return false
    void dialog
      .showMessageBox({
        type: "info",
        buttons: ["Descargar", "Cerrar"],
        defaultId: 0,
        message: "No se puede instalar la actualización aquí.",
        detail: "Mueve FlupCode a Aplicaciones o descarga la nueva versión e instálala a mano.",
      })
      .then((result) => {
        if (result.response === 0) void shell.openExternal(RELEASES_URL)
      })
    return false
  }
  installing = true
  pendingZip = undefined
  spawn("/bin/bash", ["-c", INSTALL_SCRIPT, "flupcode-update", String(process.pid), zip, bundle, reopen ? "1" : "0"], {
    detached: true,
    stdio: "ignore",
  }).unref()
  return true
}

export function initAutoUpdate() {
  if (!app.isPackaged || started) return
  started = true

  const selfInstall = selfInstallsOnMac()
  autoUpdater.autoDownload = true
  // On self-installing Macs Squirrel must not be asked to install: it rejects the update.
  autoUpdater.autoInstallOnAppQuit = !selfInstall

  autoUpdater.on("error", (error) => {
    if (!manual) return
    dialog.showErrorBox("Actualización", error.message)
  })

  autoUpdater.on("update-downloaded", (event) => {
    if (selfInstall) pendingZip = event.downloadedFile
    void dialog
      .showMessageBox({
        type: "question",
        buttons: ["Reiniciar ahora", "Más tarde"],
        defaultId: 0,
        message: `FlupCode ${event.version} está listo.`,
        detail: "Reinicia para instalar la actualización.",
      })
      .then((result) => {
        if (result.response !== 0) return
        if (!selfInstall) return autoUpdater.quitAndInstall()
        if (installOnMac(event.downloadedFile, true)) app.quit()
      })
  })

  if (selfInstall) {
    app.on("will-quit", () => {
      if (pendingZip && !installing) installOnMac(pendingZip, false)
    })
  }

  const check = () => void autoUpdater.checkForUpdates().catch(() => undefined)
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
    const result = await autoUpdater.checkForUpdates()
    if (!result?.isUpdateAvailable)
      dialog.showMessageBox({ message: `FlupCode ${app.getVersion()} es la última versión.` })
  } catch (error) {
    dialog.showErrorBox("Actualización", error instanceof Error ? error.message : String(error))
  } finally {
    manual = false
  }
}
