import Foundation

/// Whether the mic and speech recognition may be used. Both must be granted for voice mode.
public enum VoicePermission: Sendable, Equatable {
  case undetermined, granted, denied
}

/// One recognizer result. `text` is the whole utterance so far, not a delta.
public struct SpeechRecognitionEvent: Sendable, Equatable {
  public let text: String
  public let isFinal: Bool

  public init(text: String, isFinal: Bool) {
    self.text = text
    self.isFinal = isFinal
  }
}

/// Streaming speech recognition, behind a seam so the conversation loop runs without a microphone.
public protocol SpeechListening: Sendable {
  func permission() async -> VoicePermission
  /// Asks for microphone and speech-recognition access; `true` only when both are granted.
  func requestPermission() async -> Bool
  /// Starts a fresh recognition task. The stream ends when the task does (final result, error, limit).
  func start() async throws -> AsyncStream<SpeechRecognitionEvent>
  func stop() async
}

/// Spoken output. `speak` returns when the text has finished or `stop()` cut it off.
public protocol SpeechSpeaking: Sendable {
  func speak(_ text: String) async
  func stop() async
}

public enum VoiceAudioEvent: Sendable, Equatable {
  /// A call, Siri or an alarm took the audio session.
  case interruptionBegan
  case interruptionEnded(shouldResume: Bool)
  /// The active output (AirPods, wired headphones) went away. Playback must not jump to the speaker.
  case outputRouteLost
}

/// The shared audio session for a conversation: record and play together, echo cancelled, speaker by
/// default and Bluetooth routes allowed.
public protocol VoiceAudioSessionControlling: Sendable {
  func activate() async throws
  func deactivate() async
  /// Interruptions and route changes. Created before `activate()` so none is missed.
  func events() -> AsyncStream<VoiceAudioEvent>
}
