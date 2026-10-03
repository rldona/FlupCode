/**
 * The part of the extension APIs FlupCode Bridge uses, typed by hand so the package needs no
 * dependency: https://developer.chrome.com/docs/extensions/reference/api
 */

declare namespace chrome {
  export type Event<T extends (...args: never[]) => unknown> = { addListener(callback: T): void }

  export namespace runtime {
    const id: string
    function getManifest(): { version: string }
    function sendMessage<T = unknown>(message: unknown): Promise<T>
    const onMessage: Event<
      (message: { type?: string } & Record<string, unknown>, sender: unknown, respond: (value: unknown) => void) => boolean | void
    >
    const onStartup: Event<() => void>
    const onInstalled: Event<() => void>
  }

  export namespace i18n {
    function getMessage(name: string): string
  }

  export namespace storage {
    type Area = {
      get(keys: string[]): Promise<Record<string, unknown>>
      set(items: Record<string, unknown>): Promise<void>
      remove(keys: string | string[]): Promise<void>
    }
    const local: Area
    const onChanged: Event<(changes: Record<string, { newValue?: unknown }>, area: string) => void>
  }

  export namespace alarms {
    function create(name: string, info: { periodInMinutes: number }): Promise<void>
    const onAlarm: Event<(alarm: { name: string }) => void>
  }

  export namespace action {
    function setBadgeText(details: { text: string }): Promise<void>
    function setBadgeBackgroundColor(details: { color: string }): Promise<void>
  }

  export namespace tabs {
    type Tab = {
      id?: number
      windowId: number
      groupId: number
      url?: string
      title?: string
      status?: "loading" | "complete" | "unloaded"
      active: boolean
    }
    function get(tabId: number): Promise<Tab>
    function query(query: { groupId?: number; active?: boolean; lastFocusedWindow?: boolean }): Promise<Tab[]>
    function create(properties: { url?: string; active?: boolean; windowId?: number }): Promise<Tab>
    function update(tabId: number, properties: { active?: boolean }): Promise<Tab>
    function remove(tabId: number): Promise<void>
    function group(options: { tabIds: number[]; groupId?: number; createProperties?: { windowId?: number } }): Promise<number>
    function ungroup(tabIds: number[]): Promise<void>
    const onUpdated: Event<(tabId: number, change: { url?: string; status?: string }, tab: Tab) => void>
  }

  export namespace tabGroups {
    type TabGroup = { id: number; title?: string; windowId: number }
    function get(groupId: number): Promise<TabGroup>
    function query(query: { title?: string; windowId?: number }): Promise<TabGroup[]>
    function update(groupId: number, properties: { title?: string; color?: string }): Promise<TabGroup>
  }

  // `debugger` is a keyword: declared under another name and exported as `chrome.debugger`.
  namespace _debugger {
    type Debuggee = { tabId?: number }
    function attach(target: Debuggee, version: string): Promise<void>
    function detach(target: Debuggee): Promise<void>
    function sendCommand(target: Debuggee, method: string, params?: Record<string, unknown>): Promise<unknown>
    function getTargets(): Promise<Array<{ tabId?: number; attached: boolean }>>
    const onEvent: Event<(source: Debuggee, method: string, params?: Record<string, unknown>) => void>
    const onDetach: Event<(source: Debuggee, reason: string) => void>
  }
  export { _debugger as debugger }
}
