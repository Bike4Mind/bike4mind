import Foundation
import Observation

/// A live conversation: the stored transcript plus turns sent or streamed since it loaded.
///
/// Live turns are overlaid on the transcript by quest id. Streaming frames replace a turn's reply
/// (it is cumulative). While the realtime socket is down, or silent about an in-flight quest, the quest
/// is polled over REST instead; after a reconnect the transcript is refetched, because frames sent
/// while the socket was down are lost.
@MainActor
@Observable
public final class ChatViewModel {
  public let sessionID: String
  public let transcript: TranscriptViewModel
  public var draft = ""
  /// Turns sent or streamed since the transcript loaded, in arrival order.
  public private(set) var liveTurns: [QuestTurn] = []
  /// Sends the server never accepted, keyed by the optimistic turn's id.
  public private(set) var sendFailures: [String: APIError] = [:]
  public private(set) var isSending = false
  public private(set) var isRealtimeConnected = false
  public private(set) var hapticTrigger: HapticTrigger?

  @ObservationIgnored private let api: any B4MAPI
  @ObservationIgnored private let realtime: (any RealtimeClient)?
  @ObservationIgnored private let polling: PollingPolicy
  @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void
  @ObservationIgnored private let now: @Sendable () -> Date
  @ObservationIgnored private var hapticSequence = 0
  /// Optimistic turns whose quest id is not known yet, oldest first.
  @ObservationIgnored private var awaitingReceipt: [String] = []
  @ObservationIgnored private var lastHeardAt: [String: Date] = [:]
  @ObservationIgnored private var pollTasks: [String: Task<Void, Never>] = [:]

  public struct PollingPolicy: Sendable {
    public var interval: Duration = .seconds(2)
    /// A connected socket that has said nothing about an in-flight quest for this long is not trusted.
    public var staleAfter: TimeInterval = 10
    /// Hard stop per quest, so a quest that never finishes cannot poll forever. A later refresh heals it.
    public var maxPolls = 300

    public init() {}
  }

  public init(
    sessionID: String,
    api: any B4MAPI,
    realtime: (any RealtimeClient)?,
    polling: PollingPolicy = PollingPolicy(),
    sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
    now: @escaping @Sendable () -> Date = Date.init
  ) {
    self.sessionID = sessionID
    self.api = api
    self.realtime = realtime
    self.polling = polling
    self.sleep = sleep
    self.now = now
    transcript = TranscriptViewModel(sessionID: sessionID, api: api)
  }

  // MARK: - Reading

  /// Transcript turns with live turns overlaid by id; live turns not in the transcript come last.
  public var turns: [QuestTurn] {
    let liveByID = Dictionary(liveTurns.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    let history = transcript.turns
    let historyIDs = Set(history.map(\.id))
    return history.map { liveByID[$0.id] ?? $0 } + liveTurns.filter { !historyIDs.contains($0.id) }
  }

  public var messages: [TranscriptMessage] {
    TranscriptMapper.messages(from: turns)
  }

  public var canSend: Bool {
    !isSending && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  public func sendFailure(forQuestID questID: String) -> APIError? {
    sendFailures[questID]
  }

  public func load() async {
    await transcript.load()
  }

  public func refresh() async {
    await transcript.refresh()
    pruneSettledLiveTurns()
  }

  /// Follows the realtime socket until the calling task is cancelled. Call from the screen's `.task`.
  public func listen() async {
    guard let realtime else { return }
    let events = await realtime.events()
    isRealtimeConnected = await realtime.isConnected
    for await event in events {
      switch event {
      case .connectionChanged(let state):
        isRealtimeConnected = state == .connected
      case .refetchNeeded:
        await reconcileAfterReconnect()
      case .frame:
        if let frame = ChatStream.frame(in: event, sessionID: sessionID) { apply(frame) }
      case .subscriptionFailed:
        continue
      }
    }
  }

  /// Stops background polling; call when the screen goes away.
  public func stop() {
    for task in pollTasks.values { task.cancel() }
    pollTasks.removeAll()
  }

  // MARK: - Sending

  public func send() async {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, !isSending else { return }
    draft = ""
    let localID = "local-" + UUID().uuidString
    liveTurns.append(
      QuestTurn(id: localID, prompt: text, reply: nil, status: .pending, kind: .message, createdAt: now()))
    await submit(text, localID: localID)
  }

  public func retry(questID: String) async {
    guard sendFailures[questID] != nil, !isSending,
      let index = liveTurns.firstIndex(where: { $0.id == questID }),
      let prompt = liveTurns[index].prompt
    else { return }
    sendFailures[questID] = nil
    liveTurns[index] = liveTurns[index].updating(status: .pending)
    await submit(prompt, localID: questID)
  }

  private func submit(_ text: String, localID: String) async {
    isSending = true
    defer { isSending = false }
    awaitingReceipt.append(localID)
    do {
      let receipt = try await api.sendChatMessage(ChatSendRequest(message: text, target: .session(sessionID)))
      accept(receipt, localID: localID)
    } catch {
      awaitingReceipt.removeAll { $0 == localID }
      sendFailures[localID] = (error as? APIError) ?? .malformedResponse
      if let index = liveTurns.firstIndex(where: { $0.id == localID }) {
        liveTurns[index] = liveTurns[index].updating(status: .stopped)
      }
      play(.failed)
    }
  }

  private func accept(_ receipt: ChatSendReceipt, localID: String) {
    let stillAwaiting = awaitingReceipt.contains(localID)
    awaitingReceipt.removeAll { $0 == localID }
    lastHeardAt[receipt.questID] = lastHeardAt[receipt.questID] ?? now()

    if stillAwaiting, let localIndex = liveTurns.firstIndex(where: { $0.id == localID }) {
      if liveTurns.contains(where: { $0.id == receipt.questID }) {
        // A frame for this quest arrived first and was not matched to the optimistic turn.
        liveTurns.remove(at: localIndex)
      } else {
        let local = liveTurns[localIndex]
        let accepted =
          receipt.isRefused
          ? local.updating(
            id: receipt.questID, status: .stopped, kind: .error, errorCode: receipt.errorCode, reply: receipt.message)
          : local.updating(id: receipt.questID)
        liveTurns[localIndex] = accepted
        if receipt.isRefused { play(.failed) }
      }
    }

    if let turn = liveTurns.first(where: { $0.id == receipt.questID }), !(turn.status?.isTerminal ?? false) {
      startPolling(receipt.questID)
    }
  }

  // MARK: - Streaming

  /// Applies one frame for this session. Internal so tests can drive it without a socket.
  func apply(_ frame: ChatQuestFrame) {
    lastHeardAt[frame.questID] = now()
    let frameIsTerminal = frame.status?.isTerminal ?? false

    if let index = liveTurns.firstIndex(where: { $0.id == frame.questID }) {
      let old = liveTurns[index]
      // Frames can be overtaken by the final one (throttled sends, a reconnect replay); a settled turn
      // never goes back to running.
      if (old.status?.isTerminal ?? false) && !frameIsTerminal { return }
      let new = old.applying(frame)
      liveTurns[index] = new
      play(ChatHaptic.transition(from: old, to: new))
      return
    }

    if let localID = awaitingReceipt.first,
      let index = liveTurns.firstIndex(where: { $0.id == localID }),
      Self.prompt(liveTurns[index].prompt, matches: frame.prompt)
    {
      // The stream beat the POST response: this frame is the optimistic turn's quest.
      awaitingReceipt.removeFirst()
      let old = liveTurns[index]
      let new = old.applying(frame)
      liveTurns[index] = new
      play(ChatHaptic.transition(from: old, to: new))
      return
    }

    // A quest this screen did not send (another device, or one already in the transcript).
    let stored = transcript.turns.first { $0.id == frame.questID }
    if let stored, (stored.status?.isTerminal ?? false) && !frameIsTerminal { return }
    let base =
      stored ?? QuestTurn(id: frame.questID, prompt: frame.prompt, reply: nil, status: nil, createdAt: now())
    let new = base.applying(frame)
    liveTurns.append(new)
    play(ChatHaptic.transition(from: stored, to: new))
  }

  private static func prompt(_ local: String?, matches streamed: String?) -> Bool {
    guard let streamed = streamed?.trimmingCharacters(in: .whitespacesAndNewlines), !streamed.isEmpty else {
      return true
    }
    return local?.trimmingCharacters(in: .whitespacesAndNewlines) == streamed
  }

  // MARK: - Fallback polling

  private func startPolling(_ questID: String) {
    guard pollTasks[questID] == nil else { return }
    let interval = polling.interval
    let maxPolls = polling.maxPolls
    let sleep = self.sleep
    pollTasks[questID] = Task { [weak self] in
      var polls = 0
      while !Task.isCancelled, polls < maxPolls {
        do {
          try await sleep(interval)
        } catch {
          return
        }
        guard let self, let outcome = await self.pollOnce(questID) else { return }
        if outcome { polls += 1 }
      }
      self?.finishPolling(questID)
    }
  }

  private func finishPolling(_ questID: String) {
    pollTasks[questID] = nil
  }

  /// One polling step. Returns `nil` to stop, `true` if it fetched, `false` if the socket is trusted.
  private func pollOnce(_ questID: String) async -> Bool? {
    guard let turn = liveTurns.first(where: { $0.id == questID }), !(turn.status?.isTerminal ?? false) else {
      pollTasks[questID] = nil
      return nil
    }
    let heardRecently = now().timeIntervalSince(lastHeardAt[questID] ?? .distantPast) < polling.staleAfter
    if isRealtimeConnected && heardRecently { return false }

    do {
      let polled = try await api.quest(id: questID)
      applyPolled(polled)
      return true
    } catch let error as APIError where !error.isRetryable {
      pollTasks[questID] = nil
      return nil
    } catch {
      return true
    }
  }

  private func applyPolled(_ polled: QuestTurn) {
    guard let index = liveTurns.firstIndex(where: { $0.id == polled.id }) else { return }
    let old = liveTurns[index]
    if old.status?.isTerminal ?? false { return }
    let new = old.applying(polled: polled)
    liveTurns[index] = new
    play(ChatHaptic.transition(from: old, to: new))
  }

  // MARK: - Reconnect

  private func reconcileAfterReconnect() async {
    await refresh()
    for turn in liveTurns where !(turn.status?.isTerminal ?? false) && !turn.id.hasPrefix("local-") {
      if let polled = try? await api.quest(id: turn.id) { applyPolled(polled) }
    }
  }

  /// Live turns the refreshed transcript already shows as settled are redundant.
  private func pruneSettledLiveTurns() {
    let settled = Set(transcript.turns.filter { $0.status?.isTerminal ?? true }.map(\.id))
    liveTurns.removeAll { settled.contains($0.id) && ($0.status?.isTerminal ?? true) }
  }

  private func play(_ haptic: ChatHaptic?) {
    guard let haptic else { return }
    hapticSequence += 1
    hapticTrigger = HapticTrigger(haptic: haptic, sequence: hapticSequence)
  }
}

extension QuestTurn {
  func updating(
    id: String? = nil, status: Status? = nil, kind: Kind? = nil, errorCode: ErrorCode? = nil, reply: String? = nil
  ) -> QuestTurn {
    QuestTurn(
      id: id ?? self.id, prompt: prompt, reply: reply ?? self.reply, status: status ?? self.status,
      kind: kind ?? self.kind, errorCode: errorCode ?? self.errorCode, createdAt: createdAt,
      creditsUsed: creditsUsed, pendingAction: pendingAction)
  }
}
