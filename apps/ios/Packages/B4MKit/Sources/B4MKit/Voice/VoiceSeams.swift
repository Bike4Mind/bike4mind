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

/// A speaker that can start fetching a chunk before it is spoken, so a network voice has no gap between chunks.
/// The conversation calls `prepare` as each chunk is queued, in order, then `speak` with the same text.
@MainActor
public protocol SpeechPrefetching: AnyObject {
  func prepare(_ text: String)
}

/// Plays one encoded audio clip through the active audio session. `play` returns when the clip ends or `stop()`
/// cuts it off, and throws when the clip cannot be decoded.
public protocol AudioClipPlaying: Sendable {
  func play(_ clip: Data) async throws
  func stop() async
}

public enum VoiceAudioEvent: Sendable, Equatable {
  /// A call, Siri or an alarm took the audio session.
  case interruptionBegan
  case interruptionEnded(shouldResume: Bool)
  /// The active output (AirPods, wired headphones) went away. Playback must not jump to the speaker.
  case outputRouteLost
}

/// The shared audio session for a conversation: record and play together, speaker by default and Bluetooth
/// routes allowed. The reply's echo in the mic is kept out of the transcript by `SpeechEchoFilter`, not the session.
public protocol VoiceAudioSessionControlling: Sendable {
  func activate() async throws
  func deactivate() async
  /// Interruptions and route changes. Created before `activate()` so none is missed.
  func events() -> AsyncStream<VoiceAudioEvent>
}

/// Plays a voice's static sample from a URL. `play` returns when the sample ends or `stop()` cuts it off, and
/// throws when it cannot be loaded.
public protocol VoiceSamplePlaying: Sendable {
  func play(_ url: URL) async throws
  func stop() async
}
