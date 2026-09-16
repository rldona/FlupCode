import { type Component } from "solid-js"
import { Markdown as UpstreamMarkdown } from "@opencode-ai/session-ui/markdown"

export const Markdown: Component<{ text: string; class?: string; streaming?: boolean; cacheKey?: string }> = (
  props,
) => (
  <UpstreamMarkdown
    class={`fc-markdown ${props.class ?? ""}`}
    text={props.text ?? ""}
    streaming={props.streaming}
    cacheKey={props.cacheKey}
  />
)
