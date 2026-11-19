import Foundation

/// Stand-ins for the voice hardware, so fixture runs (`B4M_UI_FIXTURES=1`) and the simulator can walk the
/// conversation loop without a microphone or speech engine.
public enum VoiceFixtures {
  @MainActor
  public static func makeModel(
    target: ChatSendRequest.Target, api: any B4MAPI, realtime: any RealtimeClient,
    bargeInWords: Set<String> = [], opening: [String] = [], firstTurnContext: String? = nil, utteranceHandler: VoiceConversationModel.UtteranceHandler? = nil,
    script: [String] = ["What can you help me with today"], scriptDelay: Duration = .seconds(1)
  ) -> VoiceConversationModel {
    VoiceConversationModel(
      target: target, api: api, realtime: realtime, listener: FixtureListener(script: script, delay: scriptDelay),
      speaker: FixtureSpeaker(),
      audioSession: FixtureAudioSession(), bargeInWords: bargeInWords, opening: opening, firstTurnContext: firstTurnContext,
      utteranceHandler: utteranceHandler)
  }

  /// Says the next scripted sentence on each start, then stays quiet like an idle room once the script runs out.
  private final class FixtureListener: SpeechListening, @unchecked Sendable {
    private let lock = NSLock()
    private let script: [String]
    private let delay: Duration
    private var next = 0

    init(script: [String], delay: Duration) {
      self.script = script
      self.delay = delay
    }

    func permission() async -> VoicePermission { .granted }
    func requestPermission() async -> Bool { true }
    func start() async throws -> AsyncStream<SpeechRecognitionEvent> {
      let line = lock.withLock { next < script.count ? script[next] : nil }
      return AsyncStream { [delay] continuation in
        guard let line else { return }
        let task = Task {
          try? await Task.sleep(for: delay)
          guard !Task.isCancelled else { return }
          let words = line.split(separator: " ")
          if words.count > 1 {
            continuation.yield(SpeechRecognitionEvent(text: words.dropLast().joined(separator: " "), isFinal: false))
            try? await Task.sleep(for: .milliseconds(400))
          }
          continuation.yield(SpeechRecognitionEvent(text: line, isFinal: true))
          // Advanced only once said, so a recognizer restarted before its line never skips one.
          self.lock.withLock { self.next += 1 }
          continuation.finish()
        }
        continuation.onTermination = { _ in task.cancel() }
      }
    }
    func stop() async {}
  }

  private struct FixtureSpeaker: SpeechSpeaking {
    func speak(_ text: String) async { try? await Task.sleep(for: .milliseconds(40 * max(text.count, 8))) }
    func stop() async {}
  }

  private struct FixtureAudioSession: VoiceAudioSessionControlling {
    func activate() async throws {}
    func deactivate() async {}
    func events() -> AsyncStream<VoiceAudioEvent> { AsyncStream { _ in } }
  }
}
