import type { SpeechEvent } from "@flupcode/remote"

/** Dictation for the composer: the desktop's native recognizer when present, Web Speech otherwise. */

type SpeechRecognitionResult = {
  0: { transcript: string }
  isFinal: boolean
}

type SpeechRecognitionEventLike = {
  results: ArrayLike<SpeechRecognitionResult>
}

export type SpeechRecognitionLike = {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

export function speechRecognition(): SpeechRecognitionConstructor | undefined {
  if (typeof window === "undefined") return
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition
}

/** The desktop app's native macOS recognizer, exposed by the preload when its helper is present. */
export function desktopDictation() {
  return typeof window === "undefined" ? undefined : window.flupcode?.speech
}

/** Electron's Web Speech service is Chrome-only, so dictation there needs the native helper. */
function desktopShell() {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Electron")
}

export function dictationAvailable() {
  if (desktopDictation()) return true
  if (desktopShell()) return false
  return speechRecognition() !== undefined
}

type DictationOptions = {
  /** Whole text recognized in this session, not the caller's draft. */
  onTranscript: (text: string) => void
  /** The session ended, by stop, error or the recognizer finishing on its own. */
  onEnd: () => void
  onError?: (code?: string) => void
  lang?: string
}

/**
 * Starts dictation and returns a stop function, or undefined when no recognizer is available. The
 * caller prepends the draft it captured when starting, since `onTranscript` carries only the text
 * recognized here.
 */
export function startDictation(options: DictationOptions): (() => void) | undefined {
  const bridge = desktopDictation()
  if (bridge) {
    let ended = false
    const off = bridge.onEvent((event: SpeechEvent) => {
      if (event.type === "partial" || event.type === "final") {
        options.onTranscript(event.text)
        return
      }
      if (event.type === "error") {
        options.onError?.(event.code)
        end()
        return
      }
      if (event.type === "end") end()
    })
    const end = () => {
      if (ended) return
      ended = true
      off()
      options.onEnd()
    }
    void bridge.start(options.lang).catch(() => {
      options.onError?.("start")
      end()
    })
    // The helper emits its last transcript before `end`, so stopping waits for that event.
    return () => {
      if (ended) return
      void bridge.stop()
    }
  }

  const Recognition = speechRecognition()
  if (!Recognition || desktopShell()) return
  const recognition = new Recognition()
  recognition.lang = options.lang ?? navigator.language ?? "en-US"
  recognition.continuous = true
  recognition.interimResults = false
  recognition.onresult = (event) => {
    const transcript = Array.from(event.results)
      .map((result) => result[0].transcript)
      .join(" ")
    if (transcript.trim()) options.onTranscript(transcript)
  }
  recognition.onend = options.onEnd
  recognition.onerror = () => {
    options.onError?.()
    options.onEnd()
  }
  recognition.start()
  return () => recognition.stop()
}
