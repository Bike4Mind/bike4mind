import Foundation
import Observation

/// A recorded clip on disk.
public struct VoiceRecording: Sendable, Equatable {
  public let fileURL: URL
  public let duration: TimeInterval
  public static let mimeType = "audio/mp4"

  public init(fileURL: URL, duration: TimeInterval) {
    self.fileURL = fileURL
    self.duration = duration
  }
}

public enum MicrophonePermission: Sendable, Equatable {
  case undetermined, granted, denied
}

/// The audio hardware, behind a seam so the state machine is testable without a microphone.
public protocol AudioRecording: Sendable {
  func permission() async -> MicrophonePermission
  func requestPermission() async -> Bool
  /// Begins recording; throws if the audio session cannot be activated.
  func start() async throws
  /// Stops and returns the clip.
  func stop() async throws -> VoiceRecording
  /// Stops and deletes whatever was recorded.
  func cancel() async
}

public enum VoiceCaptureError: Error, Equatable, Sendable {
  case microphoneDenied
  case recordingFailed
  case tooShort
  case transcription(TranscriptionError)
  case offline
  case signedOut
  case other

  public var message: String {
    switch self {
    case .microphoneDenied: "Microphone access is off. Turn it on in Settings to record."
    case .recordingFailed: "Recording could not start."
    case .tooShort: "That was too short. Hold on a little longer."
    case .transcription(.unavailable): "Transcription isn't available on this server."
    case .transcription(.insufficientCredits): "Not enough credits to transcribe."
    case .transcription(.unusableRecording): "That recording can't be transcribed. Try a shorter one."
    case .transcription(.failed(let message)): message
    case .offline: "No connection. Your recording was not sent."
    case .signedOut: "Sign in again to transcribe."
    case .other: "Something went wrong."
    }
  }
}

/// Drives record -> transcribe -> text. The recording is deleted as soon as transcription finishes.
///
/// ```
/// idle -> recording -> transcribing -> transcribed(text)
///   ^         |             |               |
///   +---- failed(error) <---+---------------+--(reset)
/// ```
@MainActor
@Observable
public final class VoiceCaptureModel {
  public enum State: Equatable {
    case idle
    case recording
    case transcribing
    case transcribed(String)
    case failed(VoiceCaptureError)
  }

  public private(set) var state: State = .idle

  @ObservationIgnored private let recorder: any AudioRecording
  @ObservationIgnored private let transcriber: any TranscriptionService
  @ObservationIgnored private let minimumDuration: TimeInterval

  public init(recorder: any AudioRecording, transcriber: any TranscriptionService, minimumDuration: TimeInterval = 0.5)
  {
    self.recorder = recorder
    self.transcriber = transcriber
    self.minimumDuration = minimumDuration
  }

  public var isBusy: Bool { state == .recording || state == .transcribing }

  /// Asks for the microphone if needed, then starts recording. No-op while busy.
  public func start() async {
    guard !isBusy else { return }
    switch await recorder.permission() {
    case .denied:
      state = .failed(.microphoneDenied)
      return
    case .undetermined:
      guard await recorder.requestPermission() else {
        state = .failed(.microphoneDenied)
        return
      }
    case .granted:
      break
    }
    do {
      try await recorder.start()
      state = .recording
    } catch {
      state = .failed(.recordingFailed)
    }
  }

  /// Stops and transcribes. Only meaningful while recording.
  public func stop() async {
    guard state == .recording else { return }
    let recording: VoiceRecording
    do {
      recording = try await recorder.stop()
    } catch {
      state = .failed(.recordingFailed)
      return
    }
    defer { try? FileManager.default.removeItem(at: recording.fileURL) }
    guard recording.duration >= minimumDuration else {
      state = .failed(.tooShort)
      return
    }

    state = .transcribing
    do {
      let text = try await transcriber.transcribe(audioFile: recording.fileURL, mimeType: VoiceRecording.mimeType)
      state = text.isEmpty ? .failed(.transcription(.unusableRecording)) : .transcribed(text)
    } catch let error as TranscriptionError {
      state = .failed(.transcription(error))
    } catch let error as APIError {
      state = .failed(error == .offline ? .offline : error == .signedOut ? .signedOut : .other)
    } catch {
      state = .failed(.other)
    }
  }

  public func cancel() async {
    await recorder.cancel()
    state = .idle
  }

  /// Takes the finished transcript, returning to idle so the model is ready for another clip.
  public func consumeTranscript() -> String? {
    guard case .transcribed(let text) = state else { return nil }
    state = .idle
    return text
  }

  public func reset() {
    guard !isBusy else { return }
    state = .idle
  }
}
