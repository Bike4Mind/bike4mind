import Foundation

/// Stand-ins for the voice hardware, so fixture runs (`B4M_UI_FIXTURES=1`) and the simulator can walk the
/// conversation loop without a microphone or speech engine.
public enum VoiceFixtures {
  @MainActor
  public static func makeModel(
    target: ChatSendRequest.Target, api: any B4MAPI, realtime: any RealtimeClient,
    bargeInWords: Set<String> = [], answerPhrases: Set<String> = [], opening: [String] = [],
    firstTurnContext: String? = nil, utteranceHandler: VoiceConversationModel.UtteranceHandler? = nil,
    script: [String] = ["What can you help me with today"], quietBeforeLine: Duration = .seconds(1)
  ) -> VoiceConversationModel {
    let voice = FixtureVoice()
    return VoiceConversationModel(
      target: target, api: api, realtime: realtime,
      listener: FixtureListener(script: script, quietBeforeLine: quietBeforeLine, voice: voice),
      speaker: FixtureSpeaker(voice: voice),
      audioSession: FixtureAudioSession(), bargeInWords: bargeInWords, answerPhrases: answerPhrases, opening: opening,
      firstTurnContext: firstTurnContext, utteranceHandler: utteranceHandler)
  }

  /// When anyone last talked, so a scripted line waits for the app to finish speaking, the way a person waits
  /// for a prompt to end, instead of racing a long opening.
  private final class FixtureVoice: @unchecked Sendable {
    private let lock = NSLock()
    private var speaking = 0
    private var lastSpoke = ContinuousClock.now

    func began() { lock.withLock { speaking += 1 } }
    func ended() {
      lock.withLock {
        speaking -= 1
        lastSpoke = .now
      }
    }
    /// A scripted line counts as talk too, so the next one waits out the answer it prompts.
    func heard() { lock.withLock { lastSpoke = .now } }
    func hasBeenQuiet(for duration: Duration) -> Bool {
      lock.withLock { speaking == 0 && ContinuousClock.now - lastSpoke >= duration }
    }
  }

  /// Says the next scripted sentence on each start, once the app has been quiet for `quietBeforeLine`, then stays
  /// quiet like an idle room once the script runs out.
  private final class FixtureListener: SpeechListening, @unchecked Sendable {
    private let lock = NSLock()
    private let script: [String]
    private let quietBeforeLine: Duration
    private let voice: FixtureVoice
    private var next = 0

    init(script: [String], quietBeforeLine: Duration, voice: FixtureVoice) {
      self.script = script
      self.quietBeforeLine = quietBeforeLine
      self.voice = voice
    }

    func permission() async -> VoicePermission { .granted }
    func requestPermission() async -> Bool { true }
    func start() async throws -> AsyncStream<SpeechRecognitionEvent> {
      let line = lock.withLock { next < script.count ? script[next] : nil }
      return AsyncStream { [quietBeforeLine, voice] continuation in
        guard let line else { return }
        let task = Task {
          while !voice.hasBeenQuiet(for: quietBeforeLine) {
            try? await Task.sleep(for: .milliseconds(100))
            guard !Task.isCancelled else { return }
          }
          guard !Task.isCancelled else { return }
          let words = line.split(separator: " ")
          if words.count > 1 {
            continuation.yield(SpeechRecognitionEvent(text: words.dropLast().joined(separator: " "), isFinal: false))
            try? await Task.sleep(for: .milliseconds(400))
          }
          continuation.yield(SpeechRecognitionEvent(text: line, isFinal: true))
          voice.heard()
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
    let voice: FixtureVoice

    func speak(_ text: String) async {
      voice.began()
      try? await Task.sleep(for: .milliseconds(40 * max(text.count, 8)))
      voice.ended()
    }
    func stop() async {}
  }

  private struct FixtureAudioSession: VoiceAudioSessionControlling {
    func activate() async throws {}
    func deactivate() async {}
    func events() -> AsyncStream<VoiceAudioEvent> { AsyncStream { _ in } }
  }
}
