import Foundation

/// Stand-ins for the voice hardware, so fixture runs (`B4M_UI_FIXTURES=1`) and the simulator can walk the
/// conversation loop without a microphone or speech engine.
public enum VoiceFixtures {
  @MainActor
  public static func makeModel(
    target: ChatSendRequest.Target, api: any B4MAPI, realtime: any RealtimeClient
  ) -> VoiceConversationModel {
    VoiceConversationModel(
      target: target, api: api, realtime: realtime, listener: FixtureListener(), speaker: FixtureSpeaker(),
      audioSession: FixtureAudioSession())
  }

  /// Says one scripted sentence on the first start, then stays quiet like an idle room.
  private final class FixtureListener: SpeechListening, @unchecked Sendable {
    private let lock = NSLock()
    private var hasSpoken = false

    func permission() async -> VoicePermission { .granted }
    func requestPermission() async -> Bool { true }

    func start() async throws -> AsyncStream<SpeechRecognitionEvent> {
      let isFirst = lock.withLock { () -> Bool in
        defer { hasSpoken = true }
        return !hasSpoken
      }
      return AsyncStream { continuation in
        guard isFirst else { return }
        let task = Task {
          try? await Task.sleep(for: .seconds(1))
          continuation.yield(SpeechRecognitionEvent(text: "What can you help me with", isFinal: false))
          try? await Task.sleep(for: .milliseconds(400))
          continuation.yield(SpeechRecognitionEvent(text: "What can you help me with today", isFinal: true))
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
