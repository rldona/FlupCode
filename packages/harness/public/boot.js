// Startup guard. Plain script, loaded before the app bundle, so it still works when the bundle
// fails to load or throws before rendering: instead of a blank page it shows the error, a reload
// button and a reset that clears FlupCode's saved data but keeps paired computers.
;(() => {
  const KEEP = [
    "flupcode.remoteHosts",
    "flupcode.remoteActive",
    "flupcode.remotePush",
    "flupcode.displayName",
    "flupcode.onboarded",
    "flupcode.locale",
    "flupcode.theme",
  ]

  const WORDS = {
    en: {
      title: "FlupCode couldn't start",
      body: "Something failed while loading the app. Reloading usually fixes it. If it keeps happening, reset the app data: your paired computers are kept.",
      reload: "Reload",
      reset: "Reset app data",
    },
    es: {
      title: "FlupCode no ha podido arrancar",
      body: "Algo ha fallado al cargar la app. Normalmente se arregla recargando. Si sigue pasando, restablece los datos de la app: los ordenadores emparejados se mantienen.",
      reload: "Recargar",
      reset: "Restablecer datos de la app",
    },
  }

  function words() {
    let language = navigator.language || "en"
    try {
      const saved = JSON.parse(localStorage.getItem("flupcode.locale") || "null")
      if (saved === "en" || saved === "es") language = saved
    } catch {}
    return WORDS[language.slice(0, 2)] || WORDS.en
  }

  function describe(error) {
    if (!error) return "The app did not render."
    if (error instanceof Error) {
      const head = `${error.name}: ${error.message}`
      return error.stack?.startsWith(head) ? error.stack : `${head}${error.stack ? `\n${error.stack}` : ""}`
    }
    return String(error)
  }

  function rootEmpty() {
    const root = document.getElementById("root")
    return !root || root.childElementCount === 0
  }

  async function reset() {
    try {
      Object.keys(localStorage)
        .filter((key) => key.startsWith("flupcode.") && !KEEP.includes(key))
        .forEach((key) => localStorage.removeItem(key))
      sessionStorage.clear()
    } catch {}
    try {
      const registrations = await navigator.serviceWorker?.getRegistrations()
      await Promise.all((registrations || []).map((registration) => registration.unregister()))
      const names = await caches?.keys()
      await Promise.all((names || []).map((name) => caches.delete(name)))
    } catch {}
    location.reload()
  }

  function button(label, primary, onClick) {
    const element = document.createElement("button")
    element.type = "button"
    element.textContent = label
    element.style.cssText = `font:inherit;font-size:16px;padding:12px 18px;border-radius:12px;cursor:pointer;border:1px solid #333;${
      primary ? "background:#6c7cff;color:#fff;border-color:#6c7cff" : "background:transparent;color:#eee"
    }`
    element.addEventListener("click", onClick)
    return element
  }

  let shown = false
  function show(error) {
    if (shown || !rootEmpty()) return
    shown = true
    const text = words()
    const page = document.createElement("div")
    page.id = "fc-boot-error"
    page.setAttribute("role", "alert")
    page.style.cssText =
      "position:fixed;inset:0;overflow:auto;background:#0f0f0f;color:#eee;font:16px/1.5 system-ui,-apple-system,sans-serif;padding:max(32px,env(safe-area-inset-top)) 24px 32px;box-sizing:border-box"
    const title = document.createElement("h1")
    title.textContent = text.title
    title.style.cssText = "font-size:24px;margin:0 0 12px"
    const body = document.createElement("p")
    body.textContent = text.body
    body.style.cssText = "margin:0 0 20px;color:#bbb"
    const actions = document.createElement("div")
    actions.style.cssText = "display:flex;flex-wrap:wrap;gap:12px;margin-bottom:24px"
    actions.append(
      button(text.reload, true, () => location.reload()),
      button(text.reset, false, () => void reset()),
    )
    const detail = document.createElement("pre")
    detail.textContent = describe(error)
    detail.style.cssText =
      "white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,monospace;color:#f99;background:#1a1a1a;border-radius:12px;padding:12px;margin:0"
    page.append(title, body, actions, detail)
    document.body.append(page)
  }

  let failure
  function fail(error) {
    failure = failure || error
    // Errors after the app has rendered are the app's to handle.
    setTimeout(() => {
      if (rootEmpty()) show(failure)
    }, 500)
  }

  window.addEventListener(
    "error",
    (event) => {
      const target = event.target
      if (target && target !== window && (target.tagName === "SCRIPT" || target.tagName === "LINK")) {
        fail(`Failed to load ${target.src || target.href}`)
        return
      }
      if (target && target !== window) return
      fail(event.error || event.message)
    },
    true,
  )
  window.addEventListener("unhandledrejection", (event) => fail(event.reason))
  window.addEventListener("flupcode:fatal", (event) => {
    failure = event.detail
    show(failure)
  })
  window.addEventListener("load", () =>
    setTimeout(() => {
      if (rootEmpty()) show(failure)
    }, 8000),
  )
})()
