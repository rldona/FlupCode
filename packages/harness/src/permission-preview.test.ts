import { expect, test } from "bun:test"
import type { PermissionV2Request, SessionMessageInfo } from "./engine-types"
import { alwaysScope, permissionPreview, previewImage } from "./permission-preview"

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

test("a browser action previews its origin, effects and sensitivity from the request", () => {
  const preview = permissionPreview(
    request({
      action: "browser_sensitive",
      resources: ["https://site:do_publish"],
      metadata: {
        kind: "browser",
        origin: "https://site",
        action: "do_publish",
        tool: "publish_tool",
        description: "Publica el post",
        sensitive: true,
        steps: [
          { index: 1, kind: "fill", selector: "[data-editor]" },
          { index: 2, kind: "click", selector: "[data-publish]" },
        ],
        screenshot: "data:image/png;base64,AAAA",
      },
    }),
    undefined,
  )
  expect(preview).toEqual({
    kind: "browser",
    origin: "https://site",
    action: "do_publish",
    tool: "publish_tool",
    description: "Publica el post",
    sensitive: true,
    steps: [
      { index: 1, kind: "fill", selector: "[data-editor]" },
      { index: 2, kind: "click", selector: "[data-publish]" },
    ],
    screenshot: "data:image/png;base64,AAAA",
  })
})

test("a browser request with no metadata still names the origin it was saved against", () => {
  expect(
    permissionPreview(request({ action: "browser", resources: ["https://site"], metadata: undefined }), undefined),
  ).toEqual({ kind: "browser", origin: "https://site", action: "browser" })
})

test("a browser preview keeps only well-formed steps and only a non-empty screenshot", () => {
  const preview = permissionPreview(
    request({
      action: "browser",
      resources: ["https://site"],
      metadata: {
        kind: "browser",
        origin: "https://site",
        action: "do_demo",
        steps: [{ index: 1, kind: "click" }, { index: "2", kind: "click" }, { index: 3 }, "nope"],
        screenshot: "",
      },
    }),
    undefined,
  )
  expect(preview).toEqual({
    kind: "browser",
    origin: "https://site",
    action: "do_demo",
    steps: [{ index: 1, kind: "click" }],
  })
})

test("a browser action with nothing useful falls back to its resources", () => {
  expect(permissionPreview(request({ action: "browser", resources: [], metadata: {} }), [])).toEqual({
    kind: "resources",
    resources: [],
  })
})

test("a screenshot is only painted when it cannot reach outside data or https", () => {
  expect(previewImage("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA")
  expect(previewImage("https://site/shot.png")).toBe("https://site/shot.png")
  expect(previewImage("javascript:alert(1)")).toBeUndefined()
  expect(previewImage("http://site/shot.png")).toBeUndefined()
})

test("a non-object metadata does not throw the browser preview", () => {
  expect(
    permissionPreview(
      request({
        action: "browser",
        resources: ["https://site"],
        metadata: "nope" as unknown as Record<string, unknown>,
      }),
      [],
    ),
  ).toEqual({ kind: "browser", origin: "https://site", action: "browser" })
})

test("allow-always for a browser action is scoped to the origin or the origin and action", () => {
  expect(alwaysScope(request({ save: ["https://site"] }))).toEqual({ wide: false, patterns: ["https://site"] })
  expect(alwaysScope(request({ save: ["https://site:do_publish"] }))).toEqual({
    wide: false,
    patterns: ["https://site:do_publish"],
  })
  expect(alwaysScope(request({ save: [] }))).toBeUndefined()
})
