import { approvalOptions, type BrowserApprovalMetadata } from "./action-approval"
import { TIER_WORDS, originOf, type BrowserPolicy, type BrowserTier } from "./browser-policy"

/**
 * The user's real browser through an MCP server (BU-02): Playwright MCP in extension mode and Chrome
 * DevTools MCP with `--autoConnect`, governed by the browser policy (BU-01).
 *
 * Neither server asks before it acts, and the engine's own rules only know the tool's name. So
 * FlupCode's engine plugin hands every call to one of these servers to `decide` here, from the
 * engine's permission hook, before the call runs: the tool's name and arguments in, allow or deny
 * out. The tier comes from the tables below, never from the plugin; the reader is asked in the
 * session as for a web action, with the same answers and grants.
 *
 * **Which page.** A call names the page it acts on only when it opens one (a URL argument). For the
 * rest the page is the one the server last reported: Playwright ends its answers with the current
 * page's address (`- Page URL:`) and lists its tabs (`### Open tabs`); DevTools MCP lists its pages
 * (`## Pages`, `[selected]`) and takes a `pageId`. The plugin passes each answer to `observe`, and the
 * page is kept per server (one browser, whichever session drives it). What FlupCode cannot see — the
 * person navigating the tab by hand between two calls — it cannot know: the next answer corrects it.
 * Until a server has reported a page, a call on "the current page" is refused with a reason, because
 * there is no site to ask about; listing the tabs is what tells it.
 *
 * **Listing tabs** (`browser_tabs` list or select, `list_pages`, `select_page`) reads no page, only
 * the addresses and titles of the tabs in reach, which is how a page becomes known. It is allowed
 * without asking and written to the audit like every other call.
 */

export const BROWSER_MCP_KINDS = ["playwright", "chrome-devtools"] as const
export type BrowserMcpKind = (typeof BROWSER_MCP_KINDS)[number]

/** A call's class: a tier of the policy, or `tabs` for listing and picking tabs. */
export type BrowserMcpClass = BrowserTier | "tabs"

/**
 * Playwright MCP's tools by tier. Running code in the page, uploading, cookies and storage, routing
 * the network, saving files and typing with `submit` are `sensitive`: each can send something, sign
 * in or read a session. A tool not listed here is `sensitive` too (see `browserMcpClass`).
 */
const PLAYWRIGHT: Record<string, BrowserMcpClass> = {
  browser_snapshot: "read",
  browser_take_screenshot: "read",
  browser_console_messages: "read",
  browser_network_requests: "read",
  browser_network_request: "read",
  browser_find: "read",
  browser_wait_for: "read",
  browser_get_config: "read",
  browser_generate_locator: "read",
  browser_verify_element_visible: "read",
  browser_verify_list_visible: "read",
  browser_verify_text_visible: "read",
  browser_verify_value: "read",
  browser_navigate: "navigate",
  browser_navigate_back: "navigate",
  browser_click: "interact",
  browser_type: "interact",
  browser_hover: "interact",
  browser_drag: "interact",
  browser_select_option: "interact",
  browser_fill_form: "interact",
  browser_press_key: "interact",
  browser_handle_dialog: "interact",
  browser_resize: "interact",
  browser_emulate_media: "interact",
  browser_close: "interact",
  browser_mouse_click_xy: "interact",
  browser_mouse_down: "interact",
  browser_mouse_up: "interact",
  browser_mouse_move_xy: "interact",
  browser_mouse_drag_xy: "interact",
  browser_mouse_wheel: "interact",
  browser_file_upload: "sensitive",
  browser_drop: "sensitive",
  browser_evaluate: "sensitive",
  browser_run_code_unsafe: "sensitive",
  browser_pdf_save: "sensitive",
  browser_storage_state: "sensitive",
  browser_set_storage_state: "sensitive",
  browser_route: "sensitive",
  browser_unroute: "sensitive",
  browser_network_state_set: "sensitive",
}

/**
 * Chrome DevTools MCP's tools by tier. Running a script, uploading, installing extensions or apps and
 * calling the page's own tools are `sensitive`; so is any tool not listed. Heap and trace tools read
 * what the page holds and are `read`, like a snapshot.
 */
const DEVTOOLS: Record<string, BrowserMcpClass> = {
  list_pages: "tabs",
  select_page: "tabs",
  take_snapshot: "read",
  take_screenshot: "read",
  wait_for: "read",
  list_console_messages: "read",
  get_console_message: "read",
  list_network_requests: "read",
  get_network_request: "read",
  get_css_styles: "read",
  list_webmcp_tools: "read",
  list_3p_developer_tools: "read",
  performance_start_trace: "read",
  performance_stop_trace: "read",
  performance_analyze_insight: "read",
  screencast_start: "read",
  screencast_stop: "read",
  take_heapsnapshot: "read",
  navigate_page: "navigate",
  new_page: "navigate",
  lighthouse_audit: "navigate",
  click: "interact",
  click_at: "interact",
  drag: "interact",
  fill: "interact",
  fill_form: "interact",
  hover: "interact",
  press_key: "interact",
  type_text: "interact",
  handle_dialog: "interact",
  emulate: "interact",
  resize_page: "interact",
  close_page: "interact",
  upload_file: "sensitive",
  evaluate_script: "sensitive",
  execute_webmcp_tool: "sensitive",
  execute_3p_developer_tool: "sensitive",
  install_extension: "sensitive",
  uninstall_extension: "sensitive",
  reload_extension: "sensitive",
  trigger_extension_action: "sensitive",
  install_pwa: "sensitive",
  uninstall_pwa: "sensitive",
  launch_pwa: "sensitive",
}

/** DevTools MCP's heap-snapshot tools work on a saved file, not a page: reading, like the snapshot. */
const HEAP_FILE_TOOL = /^(analyze|close|compare|get|query)_heapsnapshot/

/**
 * What one call does, by its tool and arguments. A tool these tables do not know (a newer release,
 * an opt-in capability) is `sensitive`: it asks every time and no grant covers it, which is the
 * strictest answer that still lets the reader say yes.
 */
export function browserMcpClass(
  kind: BrowserMcpKind,
  tool: string,
  input: Record<string, unknown> = {},
): BrowserMcpClass {
  if (kind === "playwright") {
    if (tool === "browser_tabs") {
      if (input.action === "list" || input.action === "select") return "tabs"
      if (input.action === "new") return typeof input.url === "string" ? "navigate" : "tabs"
      return input.action === "close" ? "interact" : "sensitive"
    }
    // Typing with `submit` presses Enter: it sends the form.
    if (tool === "browser_type" && input.submit === true) return "sensitive"
    return PLAYWRIGHT[tool] ?? "sensitive"
  }
  if (tool === "type_text" && typeof input.submitKey === "string" && input.submitKey) return "sensitive"
  if (HEAP_FILE_TOOL.test(tool) || tool === "list_extensions" || tool === "get_os_app_state") return "read"
  return DEVTOOLS[tool] ?? "sensitive"
}

/** The pages a server has reported: the current one, and each by its id (tab index or page id). */
export type BrowserMcpPages = { current?: string; byId: Record<string, string> }

/**
 * The address a call acts on: the one it opens, or the page it names, or the current page. Nothing
 * when the server has not reported one yet.
 */
export function browserMcpTarget(
  kind: BrowserMcpKind,
  tool: string,
  input: Record<string, unknown>,
  pages: BrowserMcpPages,
): string | undefined {
  const url = typeof input.url === "string" ? input.url : undefined
  if (kind === "playwright") {
    if (tool === "browser_navigate" || tool === "browser_tabs")
      return url ?? indexed(pages, input.index) ?? pages.current
    return pages.current
  }
  // `navigate_page` goes back, forward or reloads unless it is given an address.
  if ((tool === "navigate_page" && (input.type === "url" || (input.type === undefined && url))) || tool === "new_page")
    return url
  if (tool === "launch_pwa" && url) return url
  return indexed(pages, input.pageId) ?? pages.current
}

const indexed = (pages: BrowserMcpPages, id: unknown) =>
  typeof id === "number" || typeof id === "string" ? pages.byId[String(id)] : undefined

/**
 * The pages a server's answer reports, over what was known: Playwright's `### Open tabs` list and
 * its `- Page URL:` line, DevTools MCP's `## Pages` list. An answer that reports nothing changes
 * nothing.
 */
export function browserMcpPages(kind: BrowserMcpKind, text: string, known: BrowserMcpPages): BrowserMcpPages {
  const lines = text.split("\n").map((line) => line.trim())
  const listed = lines.flatMap((line) => {
    const tab = kind === "playwright" ? PLAYWRIGHT_TAB.exec(line) : DEVTOOLS_PAGE.exec(line)
    if (!tab) return []
    const address = kind === "playwright" ? tab[3]! : pageAddress(tab[2]!)
    return [{ id: tab[1]!, url: address, current: !!tab[kind === "playwright" ? 2 : 3] }]
  })
  const reported = kind === "playwright" ? lines.map((line) => PLAYWRIGHT_URL.exec(line)?.[1]).find(Boolean) : undefined
  const byId = listed.length > 0 ? Object.fromEntries(listed.map((tab) => [tab.id, tab.url])) : known.byId
  const current = reported ?? listed.find((tab) => tab.current)?.url ?? known.current
  return { ...(current ? { current } : {}), byId }
}

// `- 0: (current) [Title](https://…)`, optionally ` [crashed]`.
const PLAYWRIGHT_TAB = /^- (\d+):( \(current\))? \[.*\]\((\S*)\)(?: \[crashed\])?$/
const PLAYWRIGHT_URL = /^- Page URL: (\S+)$/
// `1: Title (https://…) [selected] isolatedContext=name`, or the bare address without a title.
const DEVTOOLS_PAGE = /^(\d+): (.+?)( \[selected\])?(?: isolatedContext=\S+)?$/

/** A DevTools page label is `Title (address)` or just the address. */
function pageAddress(label: string) {
  const titled = /\((\S+)\)$/.exec(label)?.[1]
  return titled && URL.canParse(titled) ? titled : label
}

/** One call, as the plugin hands it over. */
export type BrowserMcpCall = {
  sessionID: string
  /** The server's name in the engine config: what `tools.<server>.<tool>` shows. */
  server: string
  kind: BrowserMcpKind
  tool: string
  input?: Record<string, unknown>
}

/** What the plugin tells the engine: run it, or refuse with a reason. */
export type BrowserMcpVerdict = { allowed: true; reason: string } | { allowed: false; reason: string }

/** The approval asked for a call to the user's own browser: the dock says "Your browser". */
export type BrowserMcpApprovalMetadata = BrowserApprovalMetadata & { browser: "yours" }

const KIND_WORDS: Record<BrowserMcpKind, string> = {
  playwright: "Playwright MCP, in the tabs you handed over from the extension",
  "chrome-devtools": "Chrome DevTools MCP, with your whole Chrome profile",
}

export function createBrowserMcpGate(input: {
  policy: BrowserPolicy
  /** Asks the reader in the session: the value of the option picked, if any. */
  ask: (request: {
    sessionID: string
    title: string
    description: string
    options: Array<{ value: string; label: string }>
    metadata: BrowserMcpApprovalMetadata
    timeoutMs: number
  }) => Promise<string | undefined>
  timeoutMs?: number
}) {
  const pages = new Map<string, BrowserMcpPages>()
  const known = (server: string) => pages.get(server) ?? { byId: {} }
  const question = (call: BrowserMcpCall, origin: string, tier: BrowserTier) => ({
    origin,
    tier,
    sessionId: call.sessionID,
    action: `${call.server}.${call.tool}`,
  })

  return {
    /** Allow or refuse one call, asking the reader when nothing decides it yet. */
    async decide(call: BrowserMcpCall): Promise<BrowserMcpVerdict> {
      const args = call.input ?? {}
      const kind = browserMcpClass(call.kind, call.tool, args)
      if (kind === "tabs") return { allowed: true, reason: "Lists or picks tabs; reads no page" }
      const target = browserMcpTarget(call.kind, call.tool, args, known(call.server))
      const origin = target ? originOf(target) : undefined
      const asked = question(call, origin ?? target ?? "", kind)
      const verdict = input.policy.decide(asked)
      if (!target)
        return {
          allowed: false,
          reason: "FlupCode does not know which page this would act on yet. List the browser's tabs first.",
        }
      if (verdict.decision === "deny") return { allowed: false, reason: verdict.reason }
      // The call runs right after this answer, so its permit is spent here.
      if (verdict.decision === "allow" && input.policy.spend(verdict.permit, asked))
        return { allowed: true, reason: verdict.reason }
      if (verdict.decision === "allow") return { allowed: false, reason: "The policy issued no permit" }
      const site = new URL(origin!).host
      const answer = await input.ask({
        sessionID: call.sessionID,
        title: `Allow the agent to ${TIER_WORDS[kind]} on ${site}?`,
        description: `In your browser, through ${KIND_WORDS[call.kind]}: ${call.server}.${call.tool}.`,
        options: approvalOptions(kind, site),
        metadata: {
          flupcode: "browser-approval",
          origin: origin!,
          site,
          tier: kind,
          action: `${call.server}.${call.tool}`,
          browser: "yours",
        },
        timeoutMs: input.timeoutMs ?? 10 * 60 * 1000,
      })
      const permit = input.policy.answer(asked, readAnswer(answer))
      if (permit && input.policy.spend(permit, asked)) return { allowed: true, reason: "The reader allowed it" }
      return { allowed: false, reason: answer === "deny" ? "The reader denied it" : "Nobody answered the approval" }
    },

    /** What a call returned: the pages it reports are kept, and the action is written to the audit. */
    observe(call: BrowserMcpCall & { ok: boolean; text?: string }) {
      const args = call.input ?? {}
      const kind = browserMcpClass(call.kind, call.tool, args)
      const target = browserMcpTarget(call.kind, call.tool, args, known(call.server))
      input.policy.recordAction(
        question(call, (target && originOf(target)) ?? target ?? "", kind === "tabs" ? "read" : kind),
        {
          outcome: call.ok ? "success" : "failed",
          ...(kind === "tabs" ? { detail: "Listed or picked tabs" } : {}),
        },
      )
      // A navigation that went through is on its target until the answer says otherwise.
      const moved =
        call.ok && kind === "navigate" && target ? { ...known(call.server), current: target } : known(call.server)
      pages.set(call.server, browserMcpPages(call.kind, call.text ?? "", moved))
    },
  }
}

export type BrowserMcpGate = ReturnType<typeof createBrowserMcpGate>

const readAnswer = (value: string | undefined) =>
  value === "once" || value === "session" || value === "always" || value === "deny" ? value : undefined

/** A call as the plugin posts it; anything malformed is nothing. */
export function readBrowserMcpCall(body: unknown): (BrowserMcpCall & { ok: boolean; text?: string }) | undefined {
  if (typeof body !== "object" || body === null) return undefined
  const value = body as Record<string, unknown>
  const named = (key: string) => {
    const entry = value[key]
    return typeof entry === "string" && entry ? entry : undefined
  }
  const sessionID = named("sessionID")
  const server = named("server")
  const tool = named("tool")
  const kind = BROWSER_MCP_KINDS.find((entry) => entry === value.kind)
  if (!sessionID || !server || !tool || !kind) return undefined
  const input =
    typeof value.input === "object" && value.input !== null && !Array.isArray(value.input)
      ? (value.input as Record<string, unknown>)
      : {}
  return {
    sessionID,
    server,
    kind,
    tool,
    input,
    ok: value.ok === true,
    ...(typeof value.text === "string" ? { text: value.text } : {}),
  }
}
