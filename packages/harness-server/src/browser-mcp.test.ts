import { afterEach, describe, expect, test } from "bun:test"
import {
  browserMcpClass,
  browserMcpPages,
  browserMcpTarget,
  createBrowserMcpGate,
  readBrowserMcpCall,
} from "./browser-mcp"
import { createBrowserPolicy } from "./browser-policy"
import { SqliteRoutineRepository } from "./repository"

const repositories: SqliteRoutineRepository[] = []
afterEach(() => repositories.splice(0).forEach((repository) => repository.close()))

describe("tool to tier", () => {
  test("Playwright MCP's tools", () => {
    const tiers = Object.fromEntries(
      [
        "browser_snapshot",
        "browser_take_screenshot",
        "browser_console_messages",
        "browser_wait_for",
        "browser_navigate",
        "browser_navigate_back",
        "browser_click",
        "browser_type",
        "browser_hover",
        "browser_fill_form",
        "browser_press_key",
        "browser_select_option",
        "browser_close",
        "browser_file_upload",
        "browser_evaluate",
        "browser_run_code_unsafe",
        "browser_storage_state",
        "browser_route",
        "browser_pdf_save",
      ].map((tool) => [tool, browserMcpClass("playwright", tool)]),
    )
    expect(tiers).toEqual({
      browser_snapshot: "read",
      browser_take_screenshot: "read",
      browser_console_messages: "read",
      browser_wait_for: "read",
      browser_navigate: "navigate",
      browser_navigate_back: "navigate",
      browser_click: "interact",
      browser_type: "interact",
      browser_hover: "interact",
      browser_fill_form: "interact",
      browser_press_key: "interact",
      browser_select_option: "interact",
      browser_close: "interact",
      browser_file_upload: "sensitive",
      browser_evaluate: "sensitive",
      browser_run_code_unsafe: "sensitive",
      browser_storage_state: "sensitive",
      browser_route: "sensitive",
      browser_pdf_save: "sensitive",
    })
  })

  test("Playwright MCP's arguments change the tier: tabs, a new tab with an address, typing that submits", () => {
    expect(browserMcpClass("playwright", "browser_tabs", { action: "list" })).toBe("tabs")
    expect(browserMcpClass("playwright", "browser_tabs", { action: "select", index: 1 })).toBe("tabs")
    expect(browserMcpClass("playwright", "browser_tabs", { action: "new" })).toBe("tabs")
    expect(browserMcpClass("playwright", "browser_tabs", { action: "new", url: "https://a.example" })).toBe("navigate")
    expect(browserMcpClass("playwright", "browser_tabs", { action: "close", index: 0 })).toBe("interact")
    expect(browserMcpClass("playwright", "browser_tabs", { action: "something new" })).toBe("sensitive")
    expect(browserMcpClass("playwright", "browser_type", { text: "hi" })).toBe("interact")
    expect(browserMcpClass("playwright", "browser_type", { text: "hi", submit: true })).toBe("sensitive")
  })

  test("Chrome DevTools MCP's tools", () => {
    const tiers = Object.fromEntries(
      [
        "list_pages",
        "select_page",
        "take_snapshot",
        "take_screenshot",
        "list_network_requests",
        "analyze_heapsnapshot_contexts",
        "navigate_page",
        "new_page",
        "click",
        "fill",
        "fill_form",
        "press_key",
        "close_page",
        "upload_file",
        "evaluate_script",
        "install_extension",
        "execute_webmcp_tool",
      ].map((tool) => [tool, browserMcpClass("chrome-devtools", tool)]),
    )
    expect(tiers).toEqual({
      list_pages: "tabs",
      select_page: "tabs",
      take_snapshot: "read",
      take_screenshot: "read",
      list_network_requests: "read",
      analyze_heapsnapshot_contexts: "read",
      navigate_page: "navigate",
      new_page: "navigate",
      click: "interact",
      fill: "interact",
      fill_form: "interact",
      press_key: "interact",
      close_page: "interact",
      upload_file: "sensitive",
      evaluate_script: "sensitive",
      install_extension: "sensitive",
      execute_webmcp_tool: "sensitive",
    })
    expect(browserMcpClass("chrome-devtools", "type_text", { text: "hi" })).toBe("interact")
    expect(browserMcpClass("chrome-devtools", "type_text", { text: "hi", submitKey: "Enter" })).toBe("sensitive")
  })

  test("a tool neither table knows is sensitive, the strictest tier: it asks every time", () => {
    expect(browserMcpClass("playwright", "browser_teleport")).toBe("sensitive")
    expect(browserMcpClass("chrome-devtools", "something_new")).toBe("sensitive")
  })
})

describe("which page a call acts on", () => {
  const pages = {
    current: "https://current.example/a",
    byId: { "0": "https://current.example/a", "2": "https://two.example/" },
  }

  test("the address it opens, the page it names, or the current page", () => {
    expect(browserMcpTarget("playwright", "browser_navigate", { url: "https://next.example/x" }, pages)).toBe(
      "https://next.example/x",
    )
    expect(browserMcpTarget("playwright", "browser_click", { ref: "e1" }, pages)).toBe("https://current.example/a")
    expect(browserMcpTarget("playwright", "browser_tabs", { action: "close", index: 2 }, pages)).toBe(
      "https://two.example/",
    )
    expect(
      browserMcpTarget("chrome-devtools", "navigate_page", { type: "url", url: "https://next.example" }, pages),
    ).toBe("https://next.example")
    expect(browserMcpTarget("chrome-devtools", "navigate_page", { url: "https://next.example" }, pages)).toBe(
      "https://next.example",
    )
    expect(browserMcpTarget("chrome-devtools", "navigate_page", { type: "reload" }, pages)).toBe(
      "https://current.example/a",
    )
    expect(browserMcpTarget("chrome-devtools", "new_page", { url: "https://new.example" }, pages)).toBe(
      "https://new.example",
    )
    expect(browserMcpTarget("chrome-devtools", "click", { uid: "1_2", pageId: 2 }, pages)).toBe("https://two.example/")
    expect(browserMcpTarget("chrome-devtools", "click", { uid: "1_2" }, pages)).toBe("https://current.example/a")
  })

  test("nothing, before a server has reported a page", () => {
    expect(browserMcpTarget("playwright", "browser_snapshot", {}, { byId: {} })).toBeUndefined()
    expect(browserMcpTarget("chrome-devtools", "take_snapshot", { pageId: 4 }, { byId: {} })).toBeUndefined()
  })

  test("Playwright's answers: its tab list and the current page's address", () => {
    const tabs = browserMcpPages(
      "playwright",
      "### Open tabs\n- 0: [Docs (v2)](https://docs.example/v2)\n- 1: (current) [Shop [new]](https://shop.example/cart)\n",
      { byId: {} },
    )
    expect(tabs).toEqual({
      current: "https://shop.example/cart",
      byId: { "0": "https://docs.example/v2", "1": "https://shop.example/cart" },
    })
    const after = browserMcpPages(
      "playwright",
      "### Ran Playwright code\n### Page\n- Page URL: https://shop.example/paid\n- Page Title: Paid",
      tabs,
    )
    expect(after).toEqual({ current: "https://shop.example/paid", byId: tabs.byId })
    // An answer that reports no page changes nothing.
    expect(browserMcpPages("playwright", "### Result\nok", after)).toEqual(after)
  })

  test("DevTools MCP's page list", () => {
    const listed = browserMcpPages(
      "chrome-devtools",
      "## Pages\n1: Inbox (https://mail.example/inbox)\n2: https://dev.example:3000/ [selected]\n3: Search (https://search.example/?q=(a)) isolatedContext=x",
      { byId: {} },
    )
    expect(listed).toEqual({
      current: "https://dev.example:3000/",
      byId: {
        "1": "https://mail.example/inbox",
        "2": "https://dev.example:3000/",
        "3": "https://search.example/?q=(a)",
      },
    })
  })
})

describe("the gate", () => {
  const subject = (answers: Array<string | undefined> = []) => {
    const repository = new SqliteRoutineRepository(":memory:")
    repositories.push(repository)
    const asked: Array<{ title: string; metadata: Record<string, string>; options: Array<{ value: string }> }> = []
    const gate = createBrowserMcpGate({
      policy: createBrowserPolicy(repository),
      ask: async (request) => {
        asked.push(request)
        return answers.shift()
      },
    })
    return { repository, gate, asked }
  }
  const call = (tool: string, input: Record<string, unknown> = {}, sessionID = "ses_1") => ({
    sessionID,
    server: "playwright",
    kind: "playwright" as const,
    tool,
    input,
  })

  test("listing tabs needs nothing; a page it does not know yet is refused, with the reason", async () => {
    const { gate, asked } = subject()
    expect(await gate.decide(call("browser_tabs", { action: "list" }))).toMatchObject({ allowed: true })
    expect(await gate.decide(call("browser_snapshot"))).toEqual({
      allowed: false,
      reason: "FlupCode does not know which page this would act on yet. List the browser's tabs first.",
    })
    expect(asked).toEqual([])
  })

  test("the first action on a site asks; a session answer covers that tier there, and only in that session", async () => {
    const { gate, asked, repository } = subject(["session", "once"])
    gate.observe({
      ...call("browser_tabs", { action: "list" }),
      ok: true,
      text: "### Open tabs\n- 0: (current) [A](https://a.example/x)",
    })
    expect(await gate.decide(call("browser_snapshot"))).toMatchObject({ allowed: true })
    expect(asked[0]).toMatchObject({
      title: "Allow the agent to read pages on a.example?",
      metadata: {
        flupcode: "browser-approval",
        origin: "https://a.example",
        site: "a.example",
        tier: "read",
        action: "playwright.browser_snapshot",
        browser: "yours",
      },
    })
    expect(asked[0]!.options.map((option) => option.value)).toEqual(["once", "session", "always", "deny"])
    expect(await gate.decide(call("browser_snapshot"))).toMatchObject({ allowed: true })
    expect(asked).toHaveLength(1)
    // Another session has not been granted anything.
    expect(await gate.decide(call("browser_snapshot", {}, "ses_2"))).toMatchObject({ allowed: true })
    expect(asked).toHaveLength(2)
    expect(repository.listBrowserGrants()).toEqual([
      expect.objectContaining({ origin: "https://a.example", tier: "read", scope: "session", sessionID: "ses_1" }),
    ])
  })

  test("a navigation is decided on where it goes, and the page follows it", async () => {
    const { gate, asked } = subject(["once", "deny"])
    expect(await gate.decide(call("browser_navigate", { url: "https://b.example/start" }))).toMatchObject({
      allowed: true,
    })
    expect(asked[0]!.metadata).toMatchObject({ origin: "https://b.example", tier: "navigate" })
    gate.observe({
      ...call("browser_navigate", { url: "https://b.example/start" }),
      ok: true,
      text: "### Page\n- Page URL: https://b.example/home",
    })
    expect(await gate.decide(call("browser_click", { ref: "e1" }))).toEqual({
      allowed: false,
      reason: "The reader denied it",
    })
    expect(asked[1]!.metadata).toMatchObject({ origin: "https://b.example", tier: "interact" })
  })

  test("a blocked site and a page that is not a web address are refused without asking", async () => {
    const { gate, asked } = subject()
    expect(await gate.decide(call("browser_navigate", { url: "https://www.paypal.com/" }))).toMatchObject({
      allowed: false,
    })
    expect(await gate.decide(call("browser_navigate", { url: "file:///etc/passwd" }))).toEqual({
      allowed: false,
      reason: "Not a web address",
    })
    expect(asked).toEqual([])
  })

  test("a sensitive call asks every time and offers only once or deny", async () => {
    const { gate, asked } = subject(["always", "once"])
    gate.observe({ ...call("browser_snapshot"), ok: true, text: "- Page URL: https://a.example/" })
    expect(await gate.decide(call("browser_evaluate", { function: "() => 1" }))).toMatchObject({ allowed: true })
    expect(await gate.decide(call("browser_evaluate", { function: "() => 1" }))).toMatchObject({ allowed: true })
    expect(asked).toHaveLength(2)
    expect(asked[0]!.options.map((option) => option.value)).toEqual(["once", "deny"])
  })

  test("an unanswered approval refuses", async () => {
    const { gate } = subject([undefined])
    gate.observe({ ...call("browser_snapshot"), ok: true, text: "- Page URL: https://a.example/" })
    expect(await gate.decide(call("browser_click", { ref: "e1" }))).toEqual({
      allowed: false,
      reason: "Nobody answered the approval",
    })
  })

  test("every call is written to the audit with its outcome", async () => {
    const { gate, repository } = subject()
    gate.observe({
      ...call("browser_tabs", { action: "list" }),
      ok: true,
      text: "- 0: (current) [A](https://a.example/)",
    })
    gate.observe({ ...call("browser_click", { ref: "e9" }), ok: false })
    expect(
      repository
        .listBrowserAudit({ sessionID: "ses_1", limit: 10 })
        .map((entry) => [entry.kind, entry.origin, entry.tier, entry.outcome, entry.action]),
    ).toEqual([
      ["action", "https://a.example", "interact", "failed", "playwright.browser_click"],
      ["action", "", "read", "success", "playwright.browser_tabs"],
    ])
  })
})

test("a posted call is read strictly", () => {
  expect(
    readBrowserMcpCall({
      sessionID: "s",
      server: "pw",
      kind: "playwright",
      tool: "browser_click",
      input: { ref: "e1" },
    }),
  ).toEqual({
    sessionID: "s",
    server: "pw",
    kind: "playwright",
    tool: "browser_click",
    input: { ref: "e1" },
    ok: false,
  })
  expect(readBrowserMcpCall({ sessionID: "s", server: "pw", kind: "selenium", tool: "x" })).toBeUndefined()
  expect(readBrowserMcpCall({ server: "pw", kind: "playwright", tool: "x" })).toBeUndefined()
  expect(readBrowserMcpCall("nope")).toBeUndefined()
})
