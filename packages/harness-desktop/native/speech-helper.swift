import AVFoundation
import Foundation
import Speech

// Bridges macOS SFSpeechRecognizer to the desktop app. The harness spawns this helper, writes
// "stop" or "cancel" on stdin, and reads one JSON event per line on stdout.

struct SpeechEvent: Codable {
  let type: String
  var text: String?
  var final: Bool?
  var code: String?
  var message: String?
}

func emit(_ event: SpeechEvent) {
  let encoder = JSONEncoder()
  guard let data = try? encoder.encode(event), let line = String(data: data, encoding: .utf8) else { return }
  FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

final class Dictation {
  private let locale: String
  private let engine = AVAudioEngine()
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var tapInstalled = false
  private var finished = false

  init(locale: String) {
    self.locale = locale
  }

  func start() {
    SFSpeechRecognizer.requestAuthorization { status in
      guard status == .authorized else {
        emit(SpeechEvent(type: "error", code: "speech-not-authorized", message: "Speech recognition permission was not granted"))
        self.finish()
        return
      }
      AVCaptureDevice.requestAccess(for: .audio) { granted in
        guard granted else {
          emit(SpeechEvent(type: "error", code: "microphone-not-authorized", message: "Microphone permission was not granted"))
          self.finish()
          return
        }
        DispatchQueue.main.async { self.begin() }
      }
    }
  }

  private func begin() {
    guard !finished else { return }
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)) ?? SFSpeechRecognizer(),
      recognizer.isAvailable
    else {
      emit(SpeechEvent(type: "error", code: "recognizer-unavailable", message: "Speech recognition is not available"))
      finish()
      return
    }

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.addsPunctuation = true
    self.request = request

    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.channelCount > 0 else {
      emit(SpeechEvent(type: "error", code: "no-microphone", message: "No microphone input is available"))
      finish()
      return
    }

    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
      request.append(buffer)
    }
    tapInstalled = true

    engine.prepare()
    do {
      try engine.start()
    } catch {
      emit(SpeechEvent(type: "error", code: "audio-engine", message: error.localizedDescription))
      finish()
      return
    }

    task = recognizer.recognitionTask(with: request) { result, error in
      if let result = result {
        let text = result.bestTranscription.formattedString
        emit(SpeechEvent(type: result.isFinal ? "final" : "partial", text: text, final: result.isFinal))
      }
      if error != nil || (result?.isFinal ?? false) {
        self.finish()
      }
    }
    emit(SpeechEvent(type: "ready"))
  }

  func stop() {
    guard !finished else { return }
    if engine.isRunning { engine.stop() }
    removeTap()
    request?.endAudio()
    // The task should complete on its own; this keeps a stuck helper from hanging the dock.
    DispatchQueue.main.asyncAfter(deadline: .now() + 4) { self.finish() }
  }

  func cancel() {
    task?.cancel()
    finish()
  }

  private func removeTap() {
    guard tapInstalled else { return }
    tapInstalled = false
    engine.inputNode.removeTap(onBus: 0)
  }

  private func finish() {
    guard !finished else { return }
    finished = true
    if engine.isRunning { engine.stop() }
    removeTap()
    task?.cancel()
    emit(SpeechEvent(type: "end"))
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { exit(0) }
  }
}

let arguments = CommandLine.arguments
let locale = arguments.count > 1 ? arguments[1] : Locale.current.identifier
let dictation = Dictation(locale: locale)
dictation.start()

DispatchQueue.global().async {
  while let line = readLine(strippingNewline: true) {
    switch line.trimmingCharacters(in: .whitespacesAndNewlines) {
    case "stop": DispatchQueue.main.async { dictation.stop() }
    case "cancel": DispatchQueue.main.async { dictation.cancel() }
    default: break
    }
  }
  DispatchQueue.main.async { dictation.cancel() }
}

RunLoop.main.run()
