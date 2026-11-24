#if os(iOS)
  import AVFoundation
  import Foundation
  import Speech
  import os

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
        complete()
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

  /// `AudioClipPlaying` over `AVAudioPlayer`, playing through the session `AVVoiceAudioSession` activated.
  @MainActor
  public final class AVAudioClipPlayer: NSObject, AudioClipPlaying, @preconcurrency AVAudioPlayerDelegate {
    public struct UnplayableClip: Error {}

    private var player: AVAudioPlayer?
    private var finished: CheckedContinuation<Void, any Error>?

    public override init() {
      super.init()
    }

    public func play(_ clip: Data) async throws {
      complete(nil)
      let player = try AVAudioPlayer(data: clip)
      player.delegate = self
      guard player.play() else { throw UnplayableClip() }
      self.player = player
      try await withCheckedThrowingContinuation { finished = $0 }
    }

    public func stop() async {
      player?.stop()
      complete(nil)
    }

    public func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
      complete(flag ? nil : UnplayableClip())
    }

    public func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: (any Error)?) {
      complete(UnplayableClip())
    }

    private func complete(_ error: (any Error)?) {
      player = nil
      if let error { finished?.resume(throwing: error) } else { finished?.resume() }
      finished = nil
    }
  }

  /// `VoiceSamplePlaying` over `AVPlayer`. Holds a `.playback` session only while a sample plays; voice mode
  /// owns the session otherwise, and Settings is not reachable during it.
  @MainActor
  public final class AVVoiceSamplePlayer: VoiceSamplePlaying {
    public struct SampleFailed: Error {}

    private var player: AVPlayer?
    private var finished: CheckedContinuation<Void, any Error>?
    private var observers: [NSObjectProtocol] = []
    private var status: NSKeyValueObservation?
    /// Bumped per `play`, so only the latest sample releases the session.
    private var plays = 0

    public init() {}

    public func play(_ url: URL) async throws {
      finish(nil)
      plays += 1
      let started = plays
      let session = AVAudioSession.sharedInstance()
      defer {
        if started == plays { try? session.setActive(false, options: .notifyOthersOnDeactivation) }
      }
      try session.setCategory(.playback, mode: .default)
      try session.setActive(true)
      let item = AVPlayerItem(url: url)
      let player = AVPlayer(playerItem: item)
      self.player = player
      try await withCheckedThrowingContinuation { continuation in
        finished = continuation
        let center = NotificationCenter.default
        observers = [
          center.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main) {
            [weak self] _ in MainActor.assumeIsolated { self?.finish(nil, for: started) }
          },
          center.addObserver(forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: item, queue: .main) {
            [weak self] _ in MainActor.assumeIsolated { self?.finish(SampleFailed(), for: started) }
          },
        ]
        status = item.observe(\.status) { [weak self] item, _ in
          guard item.status == .failed else { return }
          Task { @MainActor in self?.finish(SampleFailed(), for: started) }
        }
        player.play()
      }
    }

    public func stop() async {
      finish(nil)
    }

    private func finish(_ error: (any Error)?, for started: Int) {
      guard started == plays else { return }
      finish(error)
    }

    private func finish(_ error: (any Error)?) {
      player?.pause()
      player = nil
      observers.forEach(NotificationCenter.default.removeObserver)
      observers = []
      status?.invalidate()
      status = nil
      guard let finished else { return }
      self.finished = nil
      if let error { finished.resume(throwing: error) } else { finished.resume() }
    }
  }

  /// `SpeechListening` over `SFSpeechRecognizer` fed by an `AVAudioEngine` input tap. Recognition stays on
  /// the device when the locale supports it, so nothing is sent to Apple unless it has to be.
  public final class SFSpeechListener: SpeechListening, @unchecked Sendable {
    private static let logger = Logger(subsystem: "com.bike4mind.app", category: "voice")
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

    // Start and stop run whole under the lock: the model can restart the listener from two tasks at once, and
    // overlapping starts would install a second tap on bus 0, which throws.
    public func start() async throws -> AsyncStream<SpeechRecognitionEvent> {
      try lock.withLock { try startLocked() }
    }

    private func startLocked() throws -> AsyncStream<SpeechRecognitionEvent> {
      stopLocked()
      guard let recognizer = SFSpeechRecognizer(locale: .current), recognizer.isAvailable else {
        throw VoiceConversationError.recognizerUnavailable
      }
      let request = SFSpeechAudioBufferRecognitionRequest()
      request.shouldReportPartialResults = true
      request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition

      let input = engine.inputNode
      enableVoiceProcessing(on: input)
      // The input format changes when voice processing turns on, so it is read after.
      let format = input.outputFormat(forBus: 0)
      guard format.sampleRate > 0, format.channelCount > 0 else { throw VoiceConversationError.audioSessionUnavailable }
      input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
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
      self.request = request
      self.task = task
      self.continuation = continuation
      return stream
    }

    /// Reduces the reply's echo in the mic where the route supports it. The reply plays through `AVSpeechSynthesizer`,
    /// outside this engine, so this is best effort; `SpeechEchoFilter` is what keeps the echo out of the transcript.
    private func enableVoiceProcessing(on input: AVAudioInputNode) {
      guard !input.isVoiceProcessingEnabled else { return }
      // The engine will not start with voice processing unless the output side is in the graph too.
      _ = engine.mainMixerNode
      do {
        try input.setVoiceProcessingEnabled(true)
      } catch {
        // The simulator and some routes do not support it; listening still works without it.
        Self.logger.error("Voice processing unavailable: \(error.localizedDescription, privacy: .public)")
        return
      }
      // The spoken reply is "other audio" to voice processing, which would otherwise duck it to near silence.
      input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
    }

    public func stop() async {
      lock.withLock { stopLocked() }
    }

    private func stopLocked() {
      let (request, task, continuation) = (self.request, self.task, self.continuation)
      self.request = nil
      self.task = nil
      self.continuation = nil
      guard request != nil || task != nil else { return }
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
      request?.endAudio()
      task?.cancel()
      continuation?.finish()
    }
  }

  /// The audio session for a conversation: play and record together in `voiceChat` mode, speaker by default,
  /// Bluetooth headsets allowed, other audio ducked and restored on exit. The reply's echo is kept out of the
  /// transcript by `SpeechEchoFilter`; voice processing on `SFSpeechListener`'s input node only reduces it.
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
