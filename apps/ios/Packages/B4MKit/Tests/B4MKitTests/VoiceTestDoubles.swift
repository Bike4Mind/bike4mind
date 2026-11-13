import Foundation

@testable import B4MKit

actor FakeSpeechListener: SpeechListening {
  var permissionState: VoicePermission = .granted
  var grantsOnRequest = true
  private(set) var startCount = 0
  private(set) var stopCount = 0
  private var continuation: AsyncStream<SpeechRecognitionEvent>.Continuation?

  func setPermission(_ state: VoicePermission, grantsOnRequest: Bool = true) {
    permissionState = state
    self.grantsOnRequest = grantsOnRequest
  }

  func permission() -> VoicePermission { permissionState }
  func requestPermission() -> Bool { grantsOnRequest }

  func start() -> AsyncStream<SpeechRecognitionEvent> {
    let (stream, continuation) = AsyncStream<SpeechRecognitionEvent>.makeStream()
    self.continuation?.finish()
    self.continuation = continuation
    startCount += 1
    return stream
  }

  func stop() {
    stopCount += 1
    continuation?.finish()
    continuation = nil
  }

  func emit(_ text: String, isFinal: Bool = false) {
    continuation?.yield(SpeechRecognitionEvent(text: text, isFinal: isFinal))
  }

  /// The recognition task ends on its own (time limit, error).
  func endTask() {
    continuation?.finish()
    continuation = nil
  }
}

/// Records what is spoken. With `holding`, each chunk "plays" until `finishCurrent()` or `stop()`.
actor FakeSpeaker: SpeechSpeaking {
  private(set) var spoken: [String] = []
  private(set) var stopCount = 0
  var holding = false
  private var playing: CheckedContinuation<Void, Never>?

  func setHolding(_ holding: Bool) { self.holding = holding }

  func speak(_ text: String) async {
    spoken.append(text)
    guard holding else { return }
    await withCheckedContinuation { playing = $0 }
  }

  func stop() {
    stopCount += 1
    finishCurrent()
  }

  func finishCurrent() {
    playing?.resume()
    playing = nil
  }
}

actor FakeVoiceAudioSession: VoiceAudioSessionControlling {
  private(set) var activations = 0
  private(set) var deactivations = 0
  var failsToActivate = false
  private var continuation: AsyncStream<VoiceAudioEvent>.Continuation?

  func setFailsToActivate(_ fails: Bool) { failsToActivate = fails }

  struct ActivationFailure: Error {}

  func activate() throws {
    if failsToActivate { throw ActivationFailure() }
    activations += 1
  }

  func deactivate() { deactivations += 1 }

  nonisolated func events() -> AsyncStream<VoiceAudioEvent> {
    let (stream, continuation) = AsyncStream<VoiceAudioEvent>.makeStream()
    Task { await self.store(continuation) }
    return stream
  }

  private func store(_ continuation: AsyncStream<VoiceAudioEvent>.Continuation) {
    self.continuation = continuation
  }

  func emit(_ event: VoiceAudioEvent) { continuation?.yield(event) }
}
