import { type Component } from "solid-js"
import { MarkdownRenderer } from "../markdown/markdown"

export const Markdown: Component<{ text: string; class?: string; streaming?: boolean; cacheKey?: string }> = (
  props,
) => (
  <MarkdownRenderer
    class={`fc-markdown ${props.class ?? ""}`}
    text={props.text ?? ""}
    streaming={props.streaming}
    cacheKey={props.cacheKey}
  />
)
