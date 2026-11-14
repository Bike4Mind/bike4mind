#if os(iOS)
  import AVFoundation
  import Foundation
  import Speech

  /// `SpeechSpeaking` over `AVSpeechSynthesizer`, which plays through the app's active audio session.
  @MainActor
  public final class AVSpeechSpeaker: NSObject, SpeechSpeaking, @preconcurrency AVSpeechSynthesizerDelegate {
    private let synthesizer = AVSpeechSynthesizer()
    private var finished: CheckedContinuation<Void, Never>?

    public override init() {
      super.init()
      synthesizer.delegate = self
    }

    public func speak(_ text: String) async {
      await withCheckedContinuation { continuation in
        finished = continuation
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
        synthesizer.speak(utterance)
      }
    }

    public func stop() async {
      synthesizer.stopSpeaking(at: .immediate)
      complete()
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
      complete()
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
      complete()
    }

    private func complete() {
      finished?.resume()
      finished = nil
    }
  }

  /// `SpeechListening` over `SFSpeechRecognizer` fed by an `AVAudioEngine` input tap. Recognition stays on
  /// the device when the locale supports it, so nothing is sent to Apple unless it has to be.
  public final class SFSpeechListener: SpeechListening, @unchecked Sendable {
    private let lock = NSLock()
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var continuation: AsyncStream<SpeechRecognitionEvent>.Continuation?

    public init() {}

    public func permission() async -> VoicePermission {
      let speech = SFSpeechRecognizer.authorizationStatus()
      let microphone = AVAudioApplication.shared.recordPermission
      if speech == .denied || speech == .restricted || microphone == .denied { return .denied }
      return speech == .authorized && microphone == .granted ? .granted : .undetermined
    }

    public func requestPermission() async -> Bool {
      let speech = await withCheckedContinuation { continuation in
        SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
      }
      guard speech else { return false }
      return await AVAudioApplication.requestRecordPermission()
    }

    public func start() async throws -> AsyncStream<SpeechRecognitionEvent> {
      await stop()
      guard let recognizer = SFSpeechRecognizer(locale: .current), recognizer.isAvailable else {
        throw VoiceConversationError.recognizerUnavailable
      }
      let request = SFSpeechAudioBufferRecognitionRequest()
      request.shouldReportPartialResults = true
      request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition

      let input = engine.inputNode
      input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in
        request.append(buffer)
      }
      engine.prepare()
      do { try engine.start() } catch {
        input.removeTap(onBus: 0)
        throw VoiceConversationError.audioSessionUnavailable
      }

      let (stream, continuation) = AsyncStream<SpeechRecognitionEvent>.makeStream()
      let task = recognizer.recognitionTask(with: request) { result, error in
        if let result {
          continuation.yield(
            SpeechRecognitionEvent(text: result.bestTranscription.formattedString, isFinal: result.isFinal))
          if result.isFinal { continuation.finish() }
        }
        if error != nil { continuation.finish() }
      }
      lock.withLock {
        self.request = request
        self.task = task
        self.continuation = continuation
      }
      return stream
    }

    public func stop() async {
      let (request, task, continuation) = lock.withLock {
        () -> (
          SFSpeechAudioBufferRecognitionRequest?, SFSpeechRecognitionTask?,
          AsyncStream<SpeechRecognitionEvent>.Continuation?
        ) in
        defer {
          self.request = nil
          self.task = nil
          self.continuation = nil
        }
        return (self.request, self.task, self.continuation)
      }
      guard request != nil || task != nil else { return }
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
      request?.endAudio()
      task?.cancel()
      continuation?.finish()
    }
  }

  /// The audio session for a conversation: play and record together in `voiceChat` mode (echo cancellation),
  /// speaker by default, Bluetooth headsets allowed, other audio ducked and restored on exit.
  public final class AVVoiceAudioSession: VoiceAudioSessionControlling {
    public init() {}

    public func activate() async throws {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(
        .playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP, .duckOthers])
      try session.setActive(true)
    }

    public func deactivate() async {
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    public func events() -> AsyncStream<VoiceAudioEvent> {
      AsyncStream { continuation in
        let center = NotificationCenter.default
        let interruption = center.addObserver(
          forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { note in
          let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(
            AVAudioSession.InterruptionType.init(rawValue:))
          switch type {
          case .began:
            continuation.yield(.interruptionBegan)
          case .ended:
            let flags = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let shouldResume = AVAudioSession.InterruptionOptions(rawValue: flags).contains(.shouldResume)
            continuation.yield(.interruptionEnded(shouldResume: shouldResume))
          default:
            break
          }
        }
        let route = center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) {
          note in
          let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).flatMap(
            AVAudioSession.RouteChangeReason.init(rawValue:))
          if reason == .oldDeviceUnavailable { continuation.yield(.outputRouteLost) }
        }
        let observers = ObserverBag([interruption, route])
        continuation.onTermination = { _ in observers.removeAll() }
      }
    }
  }

  private final class ObserverBag: @unchecked Sendable {
    private let observers: [NSObjectProtocol]
    init(_ observers: [NSObjectProtocol]) { self.observers = observers }
    func removeAll() { observers.forEach(NotificationCenter.default.removeObserver) }
  }
#endif
