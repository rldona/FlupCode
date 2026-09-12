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
}

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
    rules: [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "ask" },
    ],
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
    description: "Accepts all permissions",
    rules: [{ permission: "*", pattern: "*", action: "allow" }],
  },
]

export function permissionMode(id: string | undefined) {
  return PERMISSION_MODES.find((mode) => mode.id === id) ?? PERMISSION_MODES[0]!
}
