export type PermissionModeID = "auto" | "manual" | "accept-edits" | "bypass"

export type PermissionRule = {
  permission: string
  pattern: string
  action: "allow" | "ask" | "deny"
}

export type PermissionMode = {
  id: PermissionModeID
  label: string
  description: string
  rules: PermissionRule[]
  /** Grants what the agent's own configuration would have asked about. Only `bypass` may do this. */
  dangerous?: boolean
}

/**
 * A mode is written onto the session and merged over the resolved agent's permissions, which stay a
 * floor: an override never turns an agent's denial into an approval. What an override *can* do is
 * turn the agent's "ask" into "allow", so every mode below stays at or below what the agent already
 * grants, and `bypass` is the single, explicitly dangerous exception. Before this, `auto` wrote
 * `*: allow` on every send and silently made each session as permissive as its agent's floor let it
 * be, which is not what its own description promises.
 */
const allowReads: PermissionRule[] = [
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "glob", pattern: "*", action: "allow" },
  { permission: "grep", pattern: "*", action: "allow" },
  { permission: "list", pattern: "*", action: "allow" },
]

export const PERMISSION_MODES: PermissionMode[] = [
  {
    id: "auto",
    label: "Auto",
    description: "The agent decides based on its configured permissions",
    // No grant of its own: the agent's configuration decides, and anything reaching outside the
    // session's folder is confirmed regardless of what that configuration says.
    rules: [{ permission: "external_directory", pattern: "*", action: "ask" }],
  },
  {
    id: "manual",
    label: "Manual",
    description: "Always ask before making changes",
    rules: [{ permission: "*", pattern: "*", action: "ask" }, ...allowReads],
  },
  {
    id: "accept-edits",
    label: "Accept edits",
    description: "Automatically accept all file edits",
    rules: [
      { permission: "*", pattern: "*", action: "ask" },
      ...allowReads,
      { permission: "edit", pattern: "*", action: "allow" },
    ],
  },
  {
    id: "bypass",
    label: "Bypass permissions",
    description: "Runs everything without asking, including commands and edits outside the folder",
    rules: [{ permission: "*", pattern: "*", action: "allow" }],
    dangerous: true,
  },
]

export function permissionMode(id: string | undefined) {
  return PERMISSION_MODES.find((mode) => mode.id === id) ?? PERMISSION_MODES[0]!
}
