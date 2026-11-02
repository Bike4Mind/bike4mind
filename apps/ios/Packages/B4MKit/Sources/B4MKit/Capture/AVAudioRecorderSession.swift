#if os(iOS)
  import AVFoundation
  import Foundation

  /// `AudioRecording` over `AVAudioSession` + `AVAudioRecorder`, writing AAC in an m4a container
  /// (`audio/mp4`, which the transcription endpoint accepts).
  public final class AVAudioRecorderSession: AudioRecording, @unchecked Sendable {
    private let lock = NSLock()
    private var recorder: AVAudioRecorder?

    public init() {}

    public func permission() async -> MicrophonePermission {
      switch AVAudioApplication.shared.recordPermission {
      case .granted: .granted
      case .denied: .denied
      default: .undetermined
      }
    }

    public func requestPermission() async -> Bool {
      await AVAudioApplication.requestRecordPermission()
    }

    public func start() async throws {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
      try session.setActive(true)
      let url = FileManager.default.temporaryDirectory.appending(path: "voice-\(UUID().uuidString).m4a")
      let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: 16_000,
        AVNumberOfChannelsKey: 1,
        AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
      ]
      let recorder = try AVAudioRecorder(url: url, settings: settings)
      guard recorder.record() else { throw VoiceCaptureError.recordingFailed }
      lock.withLock { self.recorder = recorder }
    }

    public func stop() async throws -> VoiceRecording {
      guard let recorder = lock.withLock({ () -> AVAudioRecorder? in defer { self.recorder = nil }; return self.recorder })
      else { throw VoiceCaptureError.recordingFailed }
      let duration = recorder.currentTime
      recorder.stop()
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      return VoiceRecording(fileURL: recorder.url, duration: duration)
    }

    public func cancel() async {
      guard let recorder = lock.withLock({ () -> AVAudioRecorder? in defer { self.recorder = nil }; return self.recorder })
      else { return }
      recorder.stop()
      recorder.deleteRecording()
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
  }
#endif
