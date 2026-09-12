import DOMPurify from "dompurify"
import { marked } from "marked"
import { createMemo, type Component } from "solid-js"
import { escapeHtml, highlight } from "../highlight"

marked.setOptions({ gfm: true, breaks: true })

marked.use({
  renderer: {
    code(token) {
      const language = (token.lang ?? "").split(/\s+/)[0] ?? ""
      const body = highlight(token.text, language)
      const label =
        language && language !== "text"
          ? `<div class="fc-code-head"><span class="fc-code-lang">${escapeHtml(language)}</span></div>`
          : ""
      return `<div class="fc-code-block">${label}<pre class="fc-code"><code>${body}</code></pre></div>`
    },
  },
})

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
