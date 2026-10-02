/**
 * Whether a page is this app's own renderer (TI-10): the packaged `oc://renderer` build, or the dev
 * server when one is in use. The renderer's credentials are handed only to such a page, over IPC,
 * instead of riding on the process's command line where any local `ps` reads them.
 */
export function isAppPage(url: string, devUrl: string | undefined) {
  if (!URL.canParse(url)) return false
  const page = new URL(url)
  if (page.protocol === "oc:" && page.host === "renderer") return true
  return devUrl !== undefined && URL.canParse(devUrl) && page.origin === new URL(devUrl).origin
}
