/**
 * What the two composer layouts must agree on (H-26).
 *
 * A chat and a cowork mean the same thing on a phone as on a computer, and holding the microphone
 * down is the same gesture. Anything that would be a bug if the two disagreed lives here; only the
 * drawing is left to each layout.
 */

import { createSignal, onCleanup } from "solid-js"
import { t } from "./i18n"
import { toast } from "./toast"
import { startDictation } from "./dictation"

/** A plain chat: no project, so no tools, permissions or agents. */
export const isPlainChat = (mode: string, chatClass: string | undefined) => mode === "chat" && chatClass === "chat"

/** A chat with a project behind it: it earns the chrome Code has. */
export const isCowork = (chatClass: string | undefined) => chatClass === "cowork"

/** The microphone, the same way in both layouts: press to start, press to stop. */
export function useDictation(onTranscript: (text: string) => void) {
  const [listening, setListening] = createSignal(false)
  let stop: (() => void) | undefined
  onCleanup(() => stop?.())

  const toggle = (base: string) => {
    if (listening()) {
      stop?.()
      stop = undefined
      return
    }
    const started = startDictation({
      lang: navigator.language,
      onTranscript: (text) => onTranscript(`${base} ${text}`.trim()),
      onError: (code) =>
        toast(code ? `${t("Voice dictation failed")} (${code})` : t("Voice dictation failed"), "error"),
      onEnd: () => {
        stop = undefined
        setListening(false)
      },
    })
    if (!started) return
    stop = started
    setListening(true)
  }

  return { listening, toggle }
}
