// Bump this whenever the caching strategy changes so old caches are dropped on activate.
const CACHE = "flupcode-v2"

// The shell plus its hashed assets are precached on install. Parsing the built HTML keeps the
// precache correct across deploys without a generated manifest.
async function precache() {
  try {
    const response = await fetch("/", { cache: "reload" })
    if (!response.ok) return
    const cache = await caches.open(CACHE)
    await cache.put("/", response.clone())
    const html = await response.text()
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1])
    await Promise.all(
      assets.map((asset) =>
        fetch(asset).then((assetResponse) => (assetResponse.ok ? cache.put(asset, assetResponse) : undefined)),
      ),
    )
  } catch {
    // Offline installs still succeed; the next load fills the cache.
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()))
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE && (key.startsWith("flupcode-") || key.startsWith("openharness-")))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

async function handleNavigation(request) {
  try {
    const response = await fetch(request)
    if (response.ok) cacheResponse("/", response.clone())
    return response
  } catch {
    // Never surface a blank error page: fall back to the precached shell when the network is down.
    const shell = await caches.match("/")
    return shell ?? Response.error()
  }
}

async function handleAsset(request) {
  const url = new URL(request.url)
  // Vite asset filenames are content-hashed, so cached copies are safe to serve forever.
  if (url.pathname.startsWith("/assets/")) {
    const cached = await caches.match(request)
    if (cached) return cached
  }
  try {
    const response = await fetch(request)
    if (response.ok && response.type === "basic") cacheResponse(request, response.clone())
    return response
  } catch {
    return (await caches.match(request)) ?? Response.error()
  }
}

function cacheResponse(key, response) {
  caches
    .open(CACHE)
    .then((cache) => cache.put(key, response))
    .catch(() => {})
}

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET") return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  // Never buffer the engine's event stream.
  if (request.headers.get("accept")?.includes("text/event-stream")) return

  if (request.mode === "navigate") return event.respondWith(handleNavigation(request))
  event.respondWith(handleAsset(request))
})

// Remote control notifications (ADR-0011). The host encrypts the payload for this browser; the
// service worker words it in the phone's language and opens the session when tapped.

const WORDS = {
  en: {
    permission: "Needs your permission",
    question: "Has a question",
    finished: "Finished",
    failed: "Stopped with an error",
  },
  es: {
    permission: "Necesita tu permiso",
    question: "Tiene una pregunta",
    finished: "Ha terminado",
    failed: "Se ha detenido con un error",
  },
}

function words() {
  const language = (self.navigator.language || "en").slice(0, 2)
  return WORDS[language] || WORDS.en
}

self.addEventListener("push", (event) => {
  const data = (() => {
    try {
      return event.data ? event.data.json() : undefined
    } catch {
      return undefined
    }
  })()
  if (!data || typeof data.kind !== "string" || typeof data.sessionID !== "string") return
  const text = words()[data.kind] || data.kind
  const url = `/?session=${encodeURIComponent(data.sessionID)}&host=${encodeURIComponent(data.host || "")}`
  const urgent = data.kind === "permission" || data.kind === "question"
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      // Someone is looking at the app: the in-app state already shows it.
      if (windows.some((client) => client.focused)) return
      return self.registration.showNotification(data.session || "FlupCode", {
        body: data.detail ? `${text}: ${data.detail}` : text,
        tag: `${data.host}:${data.sessionID}`,
        renotify: urgent,
        requireInteraction: urgent,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        data: { url, sessionID: data.sessionID, host: data.host },
      })
    }),
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const data = event.notification.data || {}
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const client = windows[0]
      if (!client) return self.clients.openWindow(data.url || "/")
      client.postMessage({ type: "flupcode:open-session", sessionID: data.sessionID, host: data.host })
      return client.focus()
    }),
  )
})
