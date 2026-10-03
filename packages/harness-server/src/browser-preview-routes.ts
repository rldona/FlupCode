import { approvalOptions } from "./action-approval"
import type { BrowserAttach } from "./browser-attach"
import { BrowserError } from "./browser-driver"
import { NavigationBlockedError } from "./browser-egress"
import { originOf, type BrowserAnswer, type BrowserPolicy, type DecideInput } from "./browser-policy"
import { isLoopbackUrl, type Preview } from "./browser-preview"

/**
 * The person's side of the desktop preview (BU-06), behind the UI's token like `/harness/browser/*`.
 *
 * - `GET /harness/preview`: whether the desktop hosts it, and what it shows.
 * - `POST /harness/preview/navigate {url, sessionID?}`: a page on this machine opens; any other site
 *   is a `navigate` decision of the browser policy (BU-01). Unless a grant already allows it the
 *   answer is `approval_required` with the question to put to the person, and nothing opens.
 * - `POST /harness/preview/answer {url, answer, sessionID?}`: the person's answer to that question,
 *   granted with the scope they picked; the page opens on a yes.
 * - `POST /harness/preview/annotation {image, title?, sessionID?}`: a picture of the preview the
 *   person marked up, kept as a screenshot artifact for the composer's chip.
 * - `GET|POST|DELETE /harness/preview/agent` (with `x-flupcode-session`): whether the agent of that
 *   session uses the preview, handing it over, taking it back. Every command it sends then goes
 *   through the attach client and the policy, like its own browser's.
 */
export async function handlePreviewRequest(
  request: Request,
  segments: string[],
  options: { preview: Preview; policy: BrowserPolicy; attach?: BrowserAttach; others?: BrowserAttach[] },
): Promise<Response> {
  return dispatch(request, segments, options).catch(failure)
}

async function dispatch(
  request: Request,
  segments: string[],
  options: { preview: Preview; policy: BrowserPolicy; attach?: BrowserAttach; others?: BrowserAttach[] },
) {
  const route = segments[0] ?? ""
  const method = request.method
  const preview = options.preview

  if (route === "" && method === "GET")
    return json({ data: { connected: preview.connected(), ...(preview.current() ? { page: preview.current() } : {}) } })

  if (route === "navigate" && method === "POST") {
    const body = await bodyFrom(request)
    const url = typeof body.url === "string" ? body.url.trim() : ""
    if (isLoopbackUrl(url)) return json({ data: await preview.show(url) })
    const question = questionFor(url, body)
    if (!question) return error("The preview only opens web pages", "invalid_url", 400)
    const verdict = options.policy.decide(question)
    if (verdict.decision === "deny") return error(verdict.reason, "denied", 403)
    if (verdict.decision === "ask") return json({ error: verdict.reason, code: "approval_required", approval: approvalOf(question) }, 409)
    if (!options.policy.spend(verdict.permit, question)) return error("The policy issued no permit", "denied", 403)
    return json({ data: await preview.show(url) })
  }

  if (route === "answer" && method === "POST") {
    const body = await bodyFrom(request)
    const url = typeof body.url === "string" ? body.url.trim() : ""
    const question = questionFor(url, body)
    if (!question) return error("The preview only opens web pages", "invalid_url", 400)
    const answer = readAnswer(body.answer)
    if (!answer) return error("answer is once, session, always or deny", "invalid_answer", 400)
    const permit = options.policy.answer(question, answer, "person")
    if (!permit || !options.policy.spend(permit, question))
      return error(`The preview does not open ${new URL(url).host}`, "denied", 403)
    return json({ data: await preview.show(url) })
  }

  if (route === "annotation" && method === "POST") {
    const body = await bodyFrom(request)
    const image = typeof body.image === "string" ? /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(body.image)?.[1] : undefined
    if (!image) return error("image is a PNG data URL", "invalid_image", 400)
    const bytes = Buffer.from(image, "base64")
    if (bytes.byteLength > MAX_ANNOTATION) return error("The picture is too large", "too_large", 413)
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : "Preview annotation"
    const sessionID = typeof body.sessionID === "string" && body.sessionID ? body.sessionID : undefined
    const stored = preview.annotation(bytes, { title, ...(sessionID ? { sessionID } : {}) })
    return json({ data: { artifactID: stored.artifactId } }, 201)
  }

  if (route === "agent") {
    const sessionID = request.headers.get("x-flupcode-session")?.trim()
    if (!sessionID) return error("A session is required", "session_required", 400)
    if (!options.attach) return error("This server cannot hand the agent a browser", "unavailable", 404)
    if (method === "GET") return json({ data: { attached: options.attach.attached(sessionID) } })
    if (method === "POST") {
      // A session has one browser at a time: FlupCode's own or the person's lets go first.
      await Promise.all((options.others ?? []).map((other) => other.detach(sessionID)))
      await options.attach.attach(sessionID)
      return json({ data: { attached: true } }, 201)
    }
    if (method === "DELETE") {
      await options.attach.detach(sessionID)
      return json({ data: { attached: false } })
    }
  }

  return error("Not found", "not_found", 404)
}

/** A person's navigation as the policy reads it: opening and reading pages on that site. */
function questionFor(url: string, body: Record<string, unknown>): DecideInput | undefined {
  if (!originOf(url)) return undefined
  return {
    origin: url,
    tier: "navigate",
    action: "preview.navigate",
    ...(typeof body.sessionID === "string" && body.sessionID ? { sessionId: body.sessionID } : {}),
  }
}

/** The question the app puts to the person, in the words and with the scopes of every browser approval. */
function approvalOf(question: DecideInput) {
  const origin = originOf(question.origin)!
  const site = new URL(origin).host
  return {
    origin,
    site,
    tier: question.tier,
    action: question.action,
    options: approvalOptions(question.tier, site).filter((option) => option.value !== "session" || !!question.sessionId),
  }
}

const MAX_ANNOTATION = 12 * 1024 * 1024

const readAnswer = (value: unknown): BrowserAnswer =>
  value === "once" || value === "session" || value === "always" || value === "deny" ? value : undefined

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

const error = (message: string, code: string, status: number) => json({ error: message, code }, status)

const bodyFrom = async (request: Request): Promise<Record<string, unknown>> => {
  const value = await request.json().catch(() => undefined)
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function failure(cause: unknown) {
  if (cause instanceof NavigationBlockedError)
    return json({ error: cause.reason, code: "navigation_blocked", reason: cause.reason }, 403)
  if (cause instanceof BrowserError) return error(cause.message, cause.code, cause.status)
  return error(cause instanceof Error ? cause.message : String(cause), "internal_error", 500)
}
