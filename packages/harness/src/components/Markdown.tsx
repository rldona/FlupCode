import DOMPurify from "dompurify"
import { marked } from "marked"
import { createMemo, type Component } from "solid-js"

marked.setOptions({ gfm: true, breaks: true })

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node instanceof HTMLAnchorElement) {
    node.setAttribute("target", "_blank")
    node.setAttribute("rel", "noreferrer")
  }
})

export const Markdown: Component<{ text: string; class?: string }> = (props) => {
  const html = createMemo(() => DOMPurify.sanitize(marked.parse(props.text ?? "", { async: false }) as string))
  return <div class={`fc-markdown ${props.class ?? ""}`} innerHTML={html()} />
}
