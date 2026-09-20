import { expect, test } from "bun:test"
import type { PermissionV2Request, SessionMessageInfo } from "./engine-types"
import { alwaysScope, permissionPreview } from "./permission-preview"

const request = (overrides: Partial<PermissionV2Request>) =>
  ({
    id: "per_1",
    sessionID: "ses_1",
    action: "edit",
    resources: ["/work/demo/a.ts"],
    source: { type: "tool", messageID: "msg_a", callID: "call_1" },
    ...overrides,
  }) as PermissionV2Request

const transcript = (name: string, input: Record<string, unknown>) =>
  [
    {
      id: "msg_a",
      type: "assistant",
      content: [{ type: "tool", id: "call_1", name, state: { status: "pending", input } }],
    },
  ] as unknown as SessionMessageInfo[]

test("an edit previews the change, not just the path it touches", () => {
  const preview = permissionPreview(
    request({}),
    transcript("edit", { path: "/work/demo/a.ts", oldString: "const a = 1", newString: "const a = 2" }),
  )
  expect(preview).toEqual({ kind: "edit", path: "/work/demo/a.ts", before: "const a = 1", after: "const a = 2" })
})

test("a write previews what would land in the file", () => {
  const preview = permissionPreview(
    request({ resources: ["/work/demo/new.ts"] }),
    transcript("write", { path: "/work/demo/new.ts", content: "export const a = 1\n" }),
  )
  expect(preview).toEqual({ kind: "write", path: "/work/demo/new.ts", content: "export const a = 1\n" })
})

test("a command previews even before the transcript catches up with the call", () => {
  expect(permissionPreview(request({ action: "bash", resources: ["rm -rf build"] }), undefined)).toEqual({
    kind: "command",
    command: "rm -rf build",
  })
})

test("anything else falls back to the resources the request names", () => {
  expect(permissionPreview(request({ action: "custom", resources: ["a", "b"] }), [])).toEqual({
    kind: "resources",
    resources: ["a", "b"],
  })
})

test("the scope of allow-always says when it covers far more than this request", () => {
  expect(alwaysScope(request({ save: ["*"] }))).toEqual({ wide: true, patterns: ["*"] })
  expect(alwaysScope(request({ save: ["git status"] }))).toEqual({ wide: false, patterns: ["git status"] })
  expect(alwaysScope(request({ save: [] }))).toBeUndefined()
})
