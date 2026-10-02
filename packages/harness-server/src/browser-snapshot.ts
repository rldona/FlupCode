/**
 * A page as the agent reads it (BU-05): the accessibility tree Chromium computes
 * (`Accessibility.getFullAXTree`), one element per line, each with a ref the agent acts by.
 *
 * Refs are numbered in document order from `e1`, so the same page gives the same refs, and each one
 * names the DOM node it was read from (`backendDOMNodeId`). They are only good for the snapshot that
 * made them: the driver drops them on the next snapshot or navigation, so an action never lands on
 * whatever happens to sit where an old element was.
 *
 * Pure: it never touches a browser, so the shape is testable on recorded trees.
 */

/** The part of a CDP `Accessibility.AXNode` this reads. */
export type AXNode = {
  nodeId: string
  ignored?: boolean
  role?: { value?: unknown }
  name?: { value?: unknown }
  value?: { value?: unknown }
  properties?: Array<{ name: string; value?: { value?: unknown } }>
  childIds?: string[]
  parentId?: string
  backendDOMNodeId?: number
}

export type SnapshotRef = { backendNodeId: number; role: string }

/** Roles that only group: their children are shown in their place. */
const TRANSPARENT = new Set([
  "none",
  "generic",
  "presentation",
  "RootWebArea",
  "InlineTextBox",
  "LineBreak",
  "Ignored",
  "LabelText",
])
/** Roles the agent can type into. */
export const EDITABLE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"])
const NAME_LIMIT = 300

export function renderSnapshot(
  nodes: AXNode[],
  options: { limit: number; redact: (text: string) => string; find?: string },
) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]))
  const root = nodes.find((node) => !node.parentId || !byId.has(node.parentId))
  const refs = new Map<string, SnapshotRef>()
  const lines: string[] = []
  const walk = (node: AXNode, depth: number, parentName: string) => {
    const role = String(node.role?.value ?? "")
    const name = clean(options.redact(String(node.name?.value ?? "")))
    const children = (node.childIds ?? []).flatMap((id) => byId.get(id) ?? [])
    if (node.ignored || TRANSPARENT.has(role) || !role) {
      children.forEach((child) => walk(child, depth, parentName))
      return
    }
    if (role === "StaticText") {
      // The text a named element is already called by says nothing new on its own line.
      if (name && !parentName.includes(name)) lines.push(`${"  ".repeat(depth)}- text ${JSON.stringify(name)}`)
      return
    }
    const ref = node.backendDOMNodeId === undefined ? undefined : `e${refs.size + 1}`
    if (ref) refs.set(ref, { backendNodeId: node.backendDOMNodeId!, role })
    const value = clean(options.redact(String(node.value?.value ?? "")))
    lines.push(
      [
        `${"  ".repeat(depth)}- ${role}`,
        name ? ` ${JSON.stringify(name)}` : "",
        states(node)
          .map((state) => ` [${state}]`)
          .join(""),
        ref ? ` [ref=${ref}]` : "",
        value && value !== name ? `: ${JSON.stringify(value)}` : "",
      ].join(""),
    )
    children.forEach((child) => walk(child, depth + 1, name))
  }
  if (root) walk(root, 0, "")
  const needle = options.find?.toLowerCase()
  const shown = needle ? lines.filter((line) => line.toLowerCase().includes(needle)) : lines
  // Whole lines up to the limit: a cut line would read as an element that is not there.
  const fits = shown.findIndex(
    (
      (total) => (line: string) =>
        (total += line.length + 1) > options.limit
    )(0),
  )
  const kept = fits === -1 ? shown : shown.slice(0, fits)
  return { content: kept.join("\n"), truncated: kept.length < shown.length, refs }
}

/** The states worth a word: checked, disabled, expanded, required, selected, a heading's level. */
function states(node: AXNode) {
  const property = (name: string) => node.properties?.find((entry) => entry.name === name)?.value?.value
  return [
    property("checked") === "true" || property("checked") === true ? "checked" : undefined,
    property("checked") === "mixed" ? "mixed" : undefined,
    property("disabled") === true ? "disabled" : undefined,
    property("expanded") === true ? "expanded" : undefined,
    property("required") === true ? "required" : undefined,
    property("selected") === true ? "selected" : undefined,
    typeof property("level") === "number" ? `level=${property("level")}` : undefined,
  ].filter((state): state is string => state !== undefined)
}

const clean = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > NAME_LIMIT ? `${flat.slice(0, NAME_LIMIT)}…` : flat
}
