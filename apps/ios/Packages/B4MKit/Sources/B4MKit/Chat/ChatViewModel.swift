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
  /// When on, the next send starts a fire-and-forget agent run instead of a chat turn; it resets once a run
  /// starts, and stays on when the start failed so a retry is still a run.
  public var sendsAsAgentRun = false

  @ObservationIgnored private let api: any B4MAPI
  @ObservationIgnored private let realtime: (any RealtimeClient)?
  @ObservationIgnored private let polling: PollingPolicy
  @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void
  @ObservationIgnored private let now: @Sendable () -> Date
  @ObservationIgnored private let title: String
  @ObservationIgnored private let activities: (any QuestActivityTracking)?
  @ObservationIgnored private let agentRuns: (any AgentRunStarting)?
  @ObservationIgnored private var hapticSequence = 0
  /// Optimistic turns whose quest id is not known yet, oldest first.
  @ObservationIgnored private var awaitingReceipt: [String] = []
  @ObservationIgnored private var lastHeardAt: [String: Date] = [:]
  @ObservationIgnored private var pollTasks: [String: Task<Void, Never>] = [:]
  /// Quests whose final text was (or is being) fetched once they settled; see `settle(_:)`.
  @ObservationIgnored private var settledQuestIDs: Set<String> = []
  @ObservationIgnored private var settleTasks: [String: Task<Void, Never>] = [:]

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
    now: @escaping @Sendable () -> Date = Date.init,
    title: String = "",
    activities: (any QuestActivityTracking)? = nil,
    agentRuns: (any AgentRunStarting)? = nil,
    firstTurn: QuestTurn? = nil
  ) {
    self.sessionID = sessionID
    self.title = title
    self.activities = activities
    self.agentRuns = agentRuns
    self.api = api
    self.realtime = realtime
    self.polling = polling
    self.sleep = sleep
    self.now = now
    transcript = TranscriptViewModel(sessionID: sessionID, api: api)
    // A conversation this device just started: its prompt shows at once, not after the transcript round trip.
    if let firstTurn { liveTurns = [firstTurn] }
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

  /// Whether the composer can offer "run as agent": only when this build wires a run service.
  public var canRunAgent: Bool { agentRuns != nil }

  public var canSend: Bool {
    !isSending && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  public func sendFailure(forQuestID questID: String) -> APIError? {
    sendFailures[questID]
  }

  /// Call from the screen's `.task`. The first appearance loads the transcript. A reappearance after `stop()`
  /// must not leave a turn stuck on "working": agent runs send no frames, so only polling ever settles them.
  public func load() async {
    let hasUnsettledTurns = liveTurns.contains { !($0.status?.isTerminal ?? false) }
    if hasUnsettledTurns, case .loaded = transcript.state {
      await refresh()
    } else {
      await transcript.load()
    }
    resumePolling()
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
    for task in settleTasks.values { task.cancel() }
    settleTasks.removeAll()
    settledQuestIDs.removeAll()
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
    do {
      if sendsAsAgentRun, let agentRuns {
        let receipt = try await agentRuns.startRun(sessionID: sessionID, title: activityTitle(for: text), message: text)
        acceptRun(receipt, localID: localID)
        // An agent run is a deliberate, costly choice: the next message is a plain chat turn again.
        sendsAsAgentRun = false
        return
      }
      awaitingReceipt.append(localID)
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
      if let streamedIndex = liveTurns.firstIndex(where: { $0.id == receipt.questID }) {
        // A frame for this quest arrived first and was not matched to the optimistic turn.
        let streamed = liveTurns[streamedIndex]
        if streamed.prompt?.isEmpty ?? true, let prompt = liveTurns[localIndex].prompt {
          liveTurns[streamedIndex] = QuestTurn(
            id: streamed.id, prompt: prompt, reply: streamed.reply, status: streamed.status, kind: streamed.kind,
            errorCode: streamed.errorCode, createdAt: streamed.createdAt, creditsUsed: streamed.creditsUsed,
            pendingAction: streamed.pendingAction, rawReplyLength: streamed.rawReplyLength)
        }
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
      if !receipt.isRefused { startActivity(for: turn, prompt: turn.prompt) }
    }
  }

  /// The server accepted an agent run. The run is headless (no realtime frames), so its quest, the row
  /// that gains the reply, is followed by the fallback poll; the run's Live Activity is the run service's.
  private func acceptRun(_ receipt: AgentRunReceipt, localID: String) {
    guard let localIndex = liveTurns.firstIndex(where: { $0.id == localID }) else { return }
    guard let questID = receipt.questID else {
      // The server writes the quest best effort, so there may be no row to follow: nothing would ever settle
      // the optimistic turn (polling and reconnect reconciliation skip `local-` ids). The run itself goes on,
      // tracked by its Live Activity under the execution id, so the turn settles as started.
      liveTurns[localIndex] = liveTurns[localIndex].updating(status: .done, reply: Self.untrackedRunReply)
      return
    }
    lastHeardAt[questID] = lastHeardAt[questID] ?? now()
    liveTurns[localIndex] = liveTurns[localIndex].updating(id: questID)
    startPolling(questID)
  }

  static let untrackedRunReply =
    "The agent run started. Its progress shows in its Live Activity rather than in this conversation."

  private func startActivity(for turn: QuestTurn, prompt: String?) {
    activities?.questStarted(
      QuestActivityStart(
        questID: turn.id, sessionID: sessionID, title: activityTitle(for: prompt ?? ""), startedAt: now(),
        initialState: QuestActivityMapping.state(from: turn)))
  }

  /// The session's name, or the opening of the prompt for a session that has none yet.
  private func activityTitle(for prompt: String) -> String {
    let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
    if !name.isEmpty { return name }
    return QuestActivityTitle.fromPrompt(prompt)
  }

  // MARK: - Streaming

  /// Applies one frame for this session. Internal so tests can drive it without a socket.
  func apply(_ frame: ChatQuestFrame) {
    applyFrame(frame)
    if frame.status?.isTerminal ?? false { settle(frame.questID) }
  }

  private func applyFrame(_ frame: ChatQuestFrame) {
    lastHeardAt[frame.questID] = now()
    activities?.questChanged(questID: frame.questID, to: QuestActivityMapping.state(from: frame))
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

  /// Only an exact, non-empty prompt claims the optimistic turn: a prompt-less frame could be another
  /// device's quest in the same session. An unmatched frame of our own is reconciled by `accept`.
  private static func prompt(_ local: String?, matches streamed: String?) -> Bool {
    guard let streamed = streamed?.trimmingCharacters(in: .whitespacesAndNewlines), !streamed.isEmpty else {
      return false
    }
    return local?.trimmingCharacters(in: .whitespacesAndNewlines) == streamed
  }

  /// Fetches a settled quest once and takes the server's reply text. Frames carry the raw `replies`
  /// slots, while the REST body is the display text the transcript shows after a reload (choice blocks
  /// and hidden slots stripped), so the live bubble ends on exactly what a reopen would show.
  private func settle(_ questID: String) {
    guard !settledQuestIDs.contains(questID) else { return }
    settledQuestIDs.insert(questID)
    let api = self.api
    settleTasks[questID] = Task { [weak self] in
      let settled = try? await api.quest(id: questID)
      guard let self, !Task.isCancelled else { return }
      self.settleTasks[questID] = nil
      guard let settled else {
        // Let a later terminal frame try again; the frame's own text stays on screen meanwhile.
        self.settledQuestIDs.remove(questID)
        return
      }
      self.applySettled(settled)
    }
  }

  private func applySettled(_ settled: QuestTurn) {
    guard let reply = settled.reply, !reply.isEmpty,
      let index = liveTurns.firstIndex(where: { $0.id == settled.id })
    else { return }
    liveTurns[index] = liveTurns[index].updating(reply: reply)
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

  /// Picks polling back up for accepted turns still in flight; `startPolling` ignores ones already polled.
  private func resumePolling() {
    for turn in liveTurns where !(turn.status?.isTerminal ?? false) && !turn.id.hasPrefix("local-") {
      startPolling(turn.id)
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
    activities?.questChanged(questID: new.id, to: QuestActivityMapping.state(from: new))
    play(ChatHaptic.transition(from: old, to: new))
  }

  // MARK: - Reconnect

  private func reconcileAfterReconnect() async {
    await refresh()
    for turn in liveTurns where !(turn.status?.isTerminal ?? false) && !turn.id.hasPrefix("local-") {
      if let polled = try? await api.quest(id: turn.id) { applyPolled(polled) }
    }
  }

  /// Live turns the refreshed transcript already shows as settled are redundant. A transcript copy with an
  /// explicit terminal status also wins over a live copy still marked running: that live copy is one whose
  /// polling stopped (the screen went away) before it heard the end.
  private func pruneSettledLiveTurns() {
    let settled = Set(transcript.turns.filter { $0.status?.isTerminal ?? true }.map(\.id))
    let finished = Set(transcript.turns.filter { $0.status?.isTerminal == true }.map(\.id))
    liveTurns.removeAll { finished.contains($0.id) || (settled.contains($0.id) && ($0.status?.isTerminal ?? true)) }
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
      creditsUsed: creditsUsed, pendingAction: pendingAction, rawReplyLength: reply == nil ? rawReplyLength : nil)
  }
}
