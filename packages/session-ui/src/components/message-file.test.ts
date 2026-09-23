import { describe, expect, test } from "bun:test"
import type { FilePart } from "@opencode-ai/sdk/v2"
import { attached, inline, isToolImageAttachment, kind, toolImageAttachments, typeLabel } from "./message-file"

function file(part: Partial<FilePart> = {}): FilePart {
  return {
    id: "part_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "file",
    mime: "text/plain",
    url: "file:///repo/README.txt",
    filename: "README.txt",
    ...part,
  }
}

describe("message-file", () => {
  test("treats data URLs as attachments", () => {
    expect(attached(file({ url: "data:text/plain;base64,SGVsbG8=" }))).toBe(true)
    expect(attached(file())).toBe(false)
  })

  test("keeps data-backed file mentions inline", () => {
    expect(
      inline(
        file({
          source: {
            type: "file",
            path: "/repo/README.txt",
            text: { value: "@README.txt", start: 0, end: 11 },
          },
        }),
      ),
    ).toBe(true)

    const mentioned = file({
      url: "data:text/plain;base64,SGVsbG8=",
      source: {
        type: "file",
        path: "/repo/README.txt",
        text: { value: "@README.txt", start: 0, end: 11 },
      },
    })
    expect(inline(mentioned)).toBe(true)
    expect(attached(mentioned)).toBe(false)
  })

  test("separates image and file attachment kinds", () => {
    expect(kind(file({ mime: "image/png" }))).toBe("image")
    expect(kind(file({ mime: "application/pdf" }))).toBe("file")
  })

  test("labels attachment types from the basename extension", () => {
    expect(typeLabel("list.md", "text/plain", "File")).toBe("Markdown")
    expect(typeLabel("/repo/src/main.ts", "text/plain", "File")).toBe("TypeScript")
    expect(typeLabel("/tmp/report.pdf", "application/pdf", "File")).toBe("PDF")
    expect(typeLabel("notes.xyz", "text/plain", "File")).toBe("XYZ")
    expect(typeLabel("/home/user/my.project/Makefile", "text/plain", "File")).toBe("File")
    expect(typeLabel(".gitignore", "text/plain", "File")).toBe("File")
    expect(typeLabel("/repo/.env", "text/plain", "File")).toBe("File")
  })

  test("keeps only image tool attachments with a usable url", () => {
    const image = file({ mime: "image/png", url: "data:image/png;base64,iVBOR" })
    const remote = file({ mime: "image/jpeg", url: "https://example.com/map.png" })
    const document = file({ mime: "application/pdf", url: "data:application/pdf;base64,JVBER" })
    const empty = file({ mime: "image/png", url: "" })
    expect(toolImageAttachments({ status: "completed", attachments: [image, remote, document, empty] })).toEqual([
      image,
      remote,
    ])
  })

  test("ignores tool attachments unless the tool completed", () => {
    const image = file({ mime: "image/png", url: "data:image/png;base64,iVBOR" })
    expect(toolImageAttachments({ status: "running", attachments: [image] })).toEqual([])
    expect(toolImageAttachments({ status: "pending", attachments: [image] })).toEqual([])
    expect(toolImageAttachments({ status: "completed" })).toEqual([])
    expect(toolImageAttachments(undefined)).toEqual([])
  })

  test("rejects malformed tool attachments without throwing", () => {
    expect(isToolImageAttachment(undefined)).toBe(false)
    expect(isToolImageAttachment({ mime: "image/png" })).toBe(false)
    expect(isToolImageAttachment({ mime: "image/png", url: "" })).toBe(false)
    expect(isToolImageAttachment({ mime: undefined, url: "https://example.com/map.png" })).toBe(false)
    expect(isToolImageAttachment(file({ mime: "image/png", url: "data:image/png;base64,iVBOR" }))).toBe(true)
  })

  test("rejects errored tools and non-array attachments without throwing", () => {
    const image = file({ mime: "image/png", url: "data:image/png;base64,iVBOR" })
    expect(toolImageAttachments({ status: "error", attachments: [image] })).toEqual([])
    expect(toolImageAttachments({ status: "completed", attachments: null })).toEqual([])
    expect(toolImageAttachments({ status: "completed", attachments: "image" })).toEqual([])
    expect(toolImageAttachments(null)).toEqual([])
    expect(isToolImageAttachment(null)).toBe(false)
    expect(isToolImageAttachment({ url: "https://example.com/map.png" })).toBe(false)
    expect(isToolImageAttachment(file({ mime: "application/pdf", url: "data:application/pdf;base64,JVBER" }))).toBe(
      false,
    )
  })
})
