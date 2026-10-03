import { createPreview, isLoopbackUrl, type PreviewSocket } from "./browser-preview"

/**
 * The desktop app's main process, as the preview driver sees it (BU-06): it answers the commands the
 * real one answers (`preview.ts` in harness-desktop) on a page of its own, and keeps main's rule that
 * a page off this machine loads only once it was allowed. The page is a small form.
 */

export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==", "base64")

/** The accessibility tree of a small form: a heading, a field and a button. */
const TREE = {
  nodes: [
    { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Dev app" }, childIds: ["2", "3", "4"] },
    { nodeId: "2", parentId: "1", role: { value: "heading" }, name: { value: "Sign up" }, backendDOMNodeId: 10, properties: [{ name: "level", value: { value: 1 } }] },
    { nodeId: "3", parentId: "1", role: { value: "textbox" }, name: { value: "Email" }, backendDOMNodeId: 11 },
    { nodeId: "4", parentId: "1", role: { value: "button" }, name: { value: "Send" }, backendDOMNodeId: 12 },
  ],
}

export function fakeDesktop(start = "http://localhost:5173/") {
  const page = { url: start, title: "Dev app", back: [] as string[] }
  const allowed = new Set<string>()
  const commands: Array<{ method: string; params: Record<string, unknown> }> = []
  const target = { preview: undefined as ReturnType<typeof createPreview> | undefined }
  const socket: PreviewSocket & { closed?: number } = {
    send(data) {
      const message = JSON.parse(data) as { id: number; method: string; params: Record<string, unknown> }
      commands.push({ method: message.method, params: message.params })
      queueMicrotask(() => {
        const answer = respond(message.method, message.params)
        target.preview?.receive(socket, JSON.stringify({ id: message.id, ...answer }))
      })
    },
    close(code) {
      socket.closed = code
    },
  }
  const state = () => ({ url: page.url, title: page.title, loading: false, canGoBack: page.back.length > 0, canGoForward: false })
  const respond = (method: string, params: Record<string, unknown>): { result?: unknown; error?: unknown } => {
    if (method === "state") return { result: state() }
    if (method === "allow") {
      allowed.add(String(params.origin))
      return { result: true }
    }
    if (method === "navigate") {
      const url = String(params.url)
      // Main's own guard: loopback, or an origin it was told about.
      if (!isLoopbackUrl(url) && !allowed.has(new URL(url).origin))
        return { error: { code: "navigation_blocked", message: "The preview was not allowed to open that site" } }
      page.back.push(page.url)
      page.url = url
      page.title = new URL(url).host
      target.preview?.receive(socket, JSON.stringify({ event: "navigated" }))
      return { result: state() }
    }
    if (method === "back") {
      page.url = page.back.pop() ?? page.url
      return { result: state() }
    }
    if (method === "capture") return { result: { png: PNG.toString("base64") } }
    if (method === "cdp") {
      const cdp = String(params.method)
      if (cdp === "Accessibility.getFullAXTree") return { result: TREE }
      if (cdp === "DOM.getContentQuads") return { result: { quads: [[10, 20, 30, 20, 30, 40, 10, 40]] } }
      if (cdp === "Page.getLayoutMetrics") return { result: { cssLayoutViewport: { clientWidth: 1000, clientHeight: 600 } } }
      return { result: {} }
    }
    return { error: { code: "unknown", message: `unknown ${method}` } }
  }
  return {
    socket,
    commands,
    page,
    allowed,
    cdp: (method: string) => commands.filter((entry) => entry.method === "cdp" && entry.params.method === method).map((entry) => entry.params.params as Record<string, unknown>),
    attach(preview: ReturnType<typeof createPreview>) {
      target.preview = preview
      preview.connect(socket)
    },
  }
}

