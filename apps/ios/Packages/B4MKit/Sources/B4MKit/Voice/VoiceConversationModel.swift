import Foundation
import Observation

public enum VoiceConversationError: Error, Equatable, Sendable {
  case permissionDenied
  case recognizerUnavailable
  case audioSessionUnavailable
  case signedOut

  public var message: String {
    switch self {
    case .permissionDenied: "Microphone and Speech Recognition access are needed. Turn them on in Settings."
    case .recognizerUnavailable: "Speech recognition isn't available right now."
    case .audioSessionUnavailable: "The audio session could not start. Another app may be using it."
    case .signedOut: "Sign in again to keep talking."
    }
  }
}

/// One spoken exchange as the voice screen shows it. The real transcript is the session's normal turns.
public struct VoiceExchange: Identifiable, Equatable, Sendable {
  public let id: Int
  public var userText: String
  public var replyText: String
  public var creditsUsed: Double?
  public var wasInterrupted = false
}

/// The hands-free loop: listen -> send -> stream -> speak -> listen again, with barge-in.
///
/// ```
/// idle -> listening -> sending -> streaming <-> speaking -> listening
///            ^            |           |            |
///            +---- barge-in (speech or tap) ------+
/// listening/... -> paused(reason) -> listening   (call, route loss)
/// ```
///
/// The recognizer keeps running while the reply is spoken, so talking over it interrupts it. Each turn is a
/// plain chat send; nothing about the session is voice-specific server-side.
@MainActor
@Observable
public final class VoiceConversationModel {
  public enum Phase: Equatable, Sendable {
    case idle, listening, sending, streaming, speaking
    case paused(PauseReason)
    case failed(VoiceConversationError)
  }

  public enum PauseReason: Equatable, Sendable {
    /// A call or another app took the audio session.
    case interrupted
    /// Headphones or AirPods went away; resuming is the user's call so audio never jumps to the speaker.
    case outputLost
  }

  public private(set) var phase: Phase = .idle
  /// What the user is saying right now.
  public private(set) var liveTranscript = ""
  public private(set) var exchanges: [VoiceExchange] = []
  /// A short, speakable note about the last turn that did not go to plan (refused, needs approval).
  public private(set) var notice: String?
  public private(set) var isMuted = false
  /// The session the conversation is in; known after the first reply when started from a new chat.
  public private(set) var sessionID: String?

  /// Called once when a new conversation's session is created.
  @ObservationIgnored public var onSessionStarted: (@MainActor (String) -> Void)?

  private let api: any B4MAPI
  private let realtime: any RealtimeClient
  private let listener: any SpeechListening
  private let speaker: any SpeechSpeaking
  private let audioSession: any VoiceAudioSessionControlling
  private let silenceTimeout: Duration
  private let stallTimeout: Duration
  private let bargeInMinimumWords: Int
  private let sleep: @Sendable (Duration) async throws -> Void

  private var target: ChatSendRequest.Target
  private var nextExchangeID = 0

  private var audioTask: Task<Void, Never>?
  private var framesTask: Task<Void, Never>?
  private var listenTask: Task<Void, Never>?
  private var turnTask: Task<Void, Never>?
  private var silenceTask: Task<Void, Never>?
  private var speakTask: Task<Void, Never>?
  private var watchdogTask: Task<Void, Never>?
  private var listenGeneration = 0
  private var fruitlessRestarts = 0

  /// Bumped whenever a turn starts or is abandoned, so work from a stale turn can tell and drop out.
  private var turnToken = 0
  private var questID: String?
  private var unclaimedFrames: [String: ChatQuestFrame] = [:]
  private var chunker = ReplySpeechChunker()
  private var chunkSink: AsyncStream<String>.Continuation?
  private var replyFinished = false
  private var frameCount = 0

  public init(
    target: ChatSendRequest.Target, api: any B4MAPI, realtime: any RealtimeClient, listener: any SpeechListening,
    speaker: any SpeechSpeaking, audioSession: any VoiceAudioSessionControlling,
    silenceTimeout: Duration = .milliseconds(1400), stallTimeout: Duration = .seconds(20),
    bargeInMinimumWords: Int = 2,
    sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
  ) {
    self.target = target
    if case .session(let id) = target { sessionID = id }
    self.api = api
    self.realtime = realtime
    self.listener = listener
    self.speaker = speaker
    self.audioSession = audioSession
    self.silenceTimeout = silenceTimeout
    self.stallTimeout = stallTimeout
    self.bargeInMinimumWords = bargeInMinimumWords
    self.sleep = sleep
  }

  // MARK: - Lifecycle

  /// Asks for permission if needed, takes the audio session and starts listening.
  public func start() async {
    switch phase {
    case .idle, .failed: break
    default: return
    }
    var permission = await listener.permission()
    if permission == .undetermined { permission = await listener.requestPermission() ? .granted : .denied }
    guard permission == .granted else { return fail(.permissionDenied) }

    let audioEvents = audioSession.events()
    do { try await audioSession.activate() } catch { return fail(.audioSessionUnavailable) }
    audioTask = Task { [weak self] in
      for await event in audioEvents { await self?.handle(audio: event) }
    }
    framesTask = Task { [weak self, realtime] in
      for await frame in await ChatStream.updates(from: realtime, sessionID: nil) { self?.handle(frame: frame) }
    }
    phase = .listening
    await beginListening()
  }

  /// Ends the conversation and gives the audio session back.
  public func stop() async {
    turnToken += 1
    for task in [audioTask, framesTask, listenTask, silenceTask, speakTask, watchdogTask, turnTask] { task?.cancel() }
    audioTask = nil
    framesTask = nil
    listenTask = nil
    turnTask = nil
    silenceTask = nil
    speakTask = nil
    watchdogTask = nil
    chunkSink?.finish()
    chunkSink = nil
    liveTranscript = ""
    phase = .idle
    await listener.stop()
    await speaker.stop()
    await audioSession.deactivate()
  }

  /// Tap to interrupt: stops the reply and goes back to listening.
  public func interrupt() async {
    switch phase {
    case .sending, .streaming, .speaking: await abandonTurn()
    default: break
    }
  }

  public func setMuted(_ muted: Bool) async {
    guard muted != isMuted else { return }
    isMuted = muted
    if muted {
      silenceTask?.cancel()
      liveTranscript = ""
      listenGeneration += 1
      listenTask?.cancel()
      await listener.stop()
    } else if phase != .idle {
      await beginListening()
    }
  }

  /// Picks the conversation back up after a pause.
  public func resume() async {
    guard case .paused = phase else { return }
    do { try await audioSession.activate() } catch { return fail(.audioSessionUnavailable) }
    phase = .listening
    await beginListening()
  }

  // MARK: - Listening

  private func beginListening() async {
    guard !isMuted else { return }
    listenGeneration += 1
    let generation = listenGeneration
    listenTask?.cancel()
    do {
      let events = try await listener.start()
      listenTask = Task { [weak self] in
        for await event in events { await self?.handle(speech: event, generation: generation) }
        await self?.recognizerEnded(generation: generation)
      }
    } catch {
      fail(.recognizerUnavailable)
    }
  }

  private func handle(speech event: SpeechRecognitionEvent, generation: Int) async {
    guard generation == listenGeneration else { return }
    let text = event.text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    fruitlessRestarts = 0

    switch phase {
    case .listening:
      break
    case .sending, .streaming, .speaking:
      // Echo of the reply and room noise produce short fragments; real interruption takes a few words.
      guard text.split(separator: " ").count >= bargeInMinimumWords else { return }
      await abandonTurn()
    default:
      return
    }

    liveTranscript = text
    if event.isFinal {
      await commit(text)
    } else {
      armSilenceTimer(for: text)
    }
  }

  private func armSilenceTimer(for text: String) {
    silenceTask?.cancel()
    silenceTask = Task { [weak self, sleep, silenceTimeout] in
      do { try await sleep(silenceTimeout) } catch { return }
      await self?.commit(text)
    }
  }

  private func recognizerEnded(generation: Int) async {
    guard generation == listenGeneration, !isMuted else { return }
    switch phase {
    case .listening, .sending, .streaming, .speaking: break
    default: return
    }
    // A recognition task that ends on its own (time limit, a quiet stretch) is replaced. One that keeps
    // ending without hearing anything is broken, not quiet.
    fruitlessRestarts += 1
    guard fruitlessRestarts <= 3 else { return fail(.recognizerUnavailable) }
    await beginListening()
  }

  // MARK: - Turn

  private func commit(_ text: String) async {
    guard phase == .listening, !text.isEmpty else { return }
    silenceTask?.cancel()
    liveTranscript = ""
    notice = nil
    turnToken += 1
    let token = turnToken
    questID = nil
    unclaimedFrames = [:]
    chunker = ReplySpeechChunker()
    replyFinished = false
    frameCount = 0
    phase = .sending
    exchanges.append(VoiceExchange(id: nextExchangeID, userText: text, replyText: ""))
    nextExchangeID += 1
    exchanges = Array(exchanges.suffix(8))

    // The send runs in its own task: commit is reached from the listening and silence tasks, and
    // restarting the recognizer cancels those, which would cancel the in-flight request with them.
    turnTask = Task { [weak self] in await self?.runTurn(text, token: token) }
  }

  private func runTurn(_ text: String, token: Int) async {
    // A fresh recognizer, so the next utterance does not carry this one's transcript.
    await listener.stop()
    await beginListening()
    guard token == turnToken else { return }

    let receipt: ChatSendReceipt
    do {
      receipt = try await api.sendChatMessage(ChatSendRequest(message: text, target: target))
    } catch {
      guard token == turnToken else { return }
      if case APIError.signedOut = error { return fail(.signedOut) }
      return endTurn(saying: "I couldn't send that. Please try again.")
    }
    if let id = receipt.sessionID, sessionID != id {
      sessionID = id
      target = .session(id)
      onSessionStarted?(id)
    }
    guard token == turnToken else { return }
    if receipt.isRefused {
      return endTurn(saying: receipt.message ?? Self.refusalNotice(receipt.errorCode))
    }

    questID = receipt.questID
    startSpeaking(token: token)
    startWatchdog(token: token, questID: receipt.questID)
    if let buffered = unclaimedFrames[receipt.questID] { handle(frame: buffered) }
    unclaimedFrames = [:]
  }

  private func handle(frame: ChatQuestFrame) {
    guard phase == .sending || phase == .streaming || phase == .speaking, !replyFinished else { return }
    guard let questID else {
      // The reply can start before the send's own response arrives.
      unclaimedFrames[frame.questID] = frame
      return
    }
    guard frame.questID == questID else { return }
    frameCount += 1

    if let credits = frame.creditsUsed { exchanges[exchanges.count - 1].creditsUsed = credits }
    if frame.pendingAction != nil {
      replyFinished = true
      return finishStream(saying: "That needs your approval on screen.")
    }
    if frame.kind == .error {
      replyFinished = true
      return finishStream(saying: frame.reply ?? Self.refusalNotice(frame.errorCode))
    }

    let isFinal = frame.status?.isTerminal ?? false
    let reply = frame.reply ?? ""
    if !reply.isEmpty {
      exchanges[exchanges.count - 1].replyText = reply
      if phase == .sending { phase = .streaming }
    }
    for chunk in chunker.ingest(cumulative: reply, isFinal: isFinal) { chunkSink?.yield(chunk) }
    if isFinal {
      replyFinished = true
      chunkSink?.finish()
    }
  }

  /// One serial consumer per turn speaks each chunk in order and ends the turn once the reply is done.
  private func startSpeaking(token: Int) {
    let (chunks, sink) = AsyncStream<String>.makeStream()
    chunkSink = sink
    speakTask?.cancel()
    speakTask = Task { [weak self, speaker] in
      for await chunk in chunks {
        guard let self, self.turnIsCurrent(token) else { return }
        self.speakingBegan()
        await speaker.speak(chunk)
        self.speakingEnded(token: token)
      }
      self?.replyDidFinishSpeaking(token: token)
    }
  }

  private func turnIsCurrent(_ token: Int) -> Bool { token == turnToken }

  private func speakingBegan() {
    if phase == .sending || phase == .streaming { phase = .speaking }
  }

  private func speakingEnded(token: Int) {
    if token == turnToken, phase == .speaking, !replyFinished { phase = .streaming }
  }

  private func replyDidFinishSpeaking(token: Int) {
    guard token == turnToken else { return }
    watchdogTask?.cancel()
    switch phase {
    case .sending, .streaming, .speaking: phase = .listening
    default: break
    }
  }

  /// Speaks a short notice and ends the turn: refusals and approvals are heard, not just seen.
  private func finishStream(saying notice: String) {
    self.notice = notice
    chunkSink?.yield(notice)
    chunkSink?.finish()
  }

  private func endTurn(saying notice: String) {
    startSpeaking(token: turnToken)
    finishStream(saying: notice)
  }

  /// Polls the quest when frames stop arriving (socket dropped mid-reply), so a turn never hangs silently.
  private func startWatchdog(token: Int, questID: String) {
    watchdogTask?.cancel()
    watchdogTask = Task { [weak self, api, sleep, stallTimeout] in
      var lastSeen = -1
      for _ in 0..<6 {
        do { try await sleep(stallTimeout) } catch { return }
        guard let self, self.turnIsCurrent(token), !self.replyFinished else { return }
        let count = self.frameCount
        guard count == lastSeen else {
          lastSeen = count
          continue
        }
        guard let turn = try? await api.quest(id: questID) else { continue }
        self.handle(
          frame: ChatQuestFrame(
            questID: turn.id, sessionID: self.sessionID ?? "", reply: turn.reply, status: turn.status,
            kind: turn.kind, errorCode: turn.errorCode, creditsUsed: turn.creditsUsed,
            pendingAction: turn.pendingAction))
      }
      self?.watchdogGaveUp(token: token)
    }
  }

  private func watchdogGaveUp(token: Int) {
    guard token == turnToken, !replyFinished else { return }
    replyFinished = true
    finishStream(saying: "That took too long. Please try again.")
  }

  /// Drops the turn in flight: stops speech, ignores the rest of its frames and returns to listening.
  private func abandonTurn() async {
    turnToken += 1
    watchdogTask?.cancel()
    speakTask?.cancel()
    chunkSink?.finish()
    chunkSink = nil
    questID = nil
    if !exchanges.isEmpty { exchanges[exchanges.count - 1].wasInterrupted = true }
    phase = .listening
    await speaker.stop()
  }

  // MARK: - Audio session events

  private func handle(audio event: VoiceAudioEvent) async {
    switch event {
    case .interruptionBegan:
      await pause(.interrupted)
    case .outputRouteLost:
      await pause(.outputLost)
    case .interruptionEnded(let shouldResume):
      if shouldResume, phase == .paused(.interrupted) { await resume() }
    }
  }

  private func pause(_ reason: PauseReason) async {
    switch phase {
    case .idle, .failed, .paused: return
    default: break
    }
    await abandonTurn()
    silenceTask?.cancel()
    liveTranscript = ""
    listenGeneration += 1
    listenTask?.cancel()
    phase = .paused(reason)
    await listener.stop()
  }

  private func fail(_ error: VoiceConversationError) {
    phase = .failed(error)
  }

  private static func refusalNotice(_ code: QuestTurn.ErrorCode?) -> String {
    switch code {
    case .insufficientCredits: "You're out of credits."
    case .spendCapExceeded: "You've reached your spending limit."
    case nil: "Something went wrong with that one."
    }
  }
}
