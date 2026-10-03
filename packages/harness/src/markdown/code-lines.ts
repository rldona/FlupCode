import { createEffect, createSignal, on, onCleanup } from "solid-js"
import { escapeHtml } from "../highlight"
import { disposeStreamingCode, highlightStreamingCode } from "./markdown-worker"
import { tokenLines } from "./markdown-worker-protocol"

let next = 0

/**
 * Code as lines of HTML, coloured by the app's one highlighter (UX-06): the transcript's Shiki worker,
 * with the same grammar, theme and `--syntax-*` colours as a code block in a message. A file, a diff
 * or a tool's output used to go through a second, regular-expression highlighter that coloured the
 * same code differently.
 *
 * The lines are plain (escaped) until the worker answers, and stay plain for a language nobody named
 * or when there is no worker. Line `n` of the result is line `n` of the text, so a caller that draws
 * its own line numbers or diff signs indexes into it.
 */
export function createCodeLines(text: () => string, language: () => string) {
  const key = `code-lines:${++next}`
  const [coloured, setColoured] = createSignal<{ text: string; language: string; lines: string[] }>()
  createEffect(
    on([text, language], ([source, lang]) => {
      if (!lang) return
      // A promise from the start, so a missing worker (which throws) is a rejection like any other.
      void Promise.resolve()
        .then(() => highlightStreamingCode(key, source, lang, true))
        .then((state) => setColoured({ text: source, language: lang, lines: tokenLines(state.stable) }))
        // A superseded request has a newer one behind it, and without a worker the code stays plain.
        .catch(() => undefined)
    }),
  )
  onCleanup(() => disposeStreamingCode(key))
  return () => {
    const value = coloured()
    if (value && value.text === text() && value.language === language()) return value.lines
    return text().split("\n").map(escapeHtml)
  }
}
