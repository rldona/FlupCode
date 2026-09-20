const CACHE = "flupcode-v1"

self.addEventListener("install", () => {
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET") return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone()
        caches
          .open(CACHE)
          .then((cache) => cache.put(request, copy))
          .catch(() => {})
        return response
      })
      .catch(() => caches.match(request).then((cached) => cached ?? Response.error())),
  )
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
