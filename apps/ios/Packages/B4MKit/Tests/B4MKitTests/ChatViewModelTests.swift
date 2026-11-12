import XCTest

@testable import B4MKit

@MainActor
final class ChatViewModelTests: XCTestCase {
  private var api: FakeAPI!
  private var clock: TestClock!

  override func setUp() async throws {
    api = FakeAPI()
    clock = TestClock()
  }

  private func makeModel(realtime: (any RealtimeClient)?, maxPolls: Int = 300) -> ChatViewModel {
    var polling = ChatViewModel.PollingPolicy()
    polling.maxPolls = maxPolls
    return ChatViewModel(
      sessionID: "s1", api: api, realtime: realtime, polling: polling,
      sleep: { _ in
        try await Task.sleep(for: .milliseconds(1))
      }, now: clock.provider)
  }

  func testAFirstTurnShowsBeforeTheTranscriptLoads() {
    let turn = QuestTurn(id: "quest-1", prompt: "Plan my week", reply: nil, status: .pending, createdAt: Date())
    let model = ChatViewModel(sessionID: "s1", api: api, realtime: nil, firstTurn: turn)
    XCTAssertEqual(model.messages.first?.role, .user)
    XCTAssertEqual(model.messages.first?.text, "Plan my week")
  }

  private func frame(
    _ questID: String = "quest-1", session: String = "s1", reply: String?, status: QuestTurn.Status? = .running,
    prompt: String? = nil, pendingAction: PendingAction? = nil
  ) -> ChatQuestFrame {
    ChatQuestFrame(
      questID: questID, sessionID: session, prompt: prompt, reply: reply, status: status, pendingAction: pendingAction)
  }

  private func streamedEvent(_ frame: ChatQuestFrame) -> RealtimeEvent {
    var quest: JSONObject = ["id": .string(frame.questID), "sessionId": .string(frame.sessionID), "type": "message"]
    if let reply = frame.reply { quest["reply"] = .string(reply) }
    if let status = frame.status { quest["status"] = .string(status.rawValue) }
    if let prompt = frame.prompt { quest["prompt"] = .string(prompt) }
    return .frame(
      ActionFrame(
        action: "streamed_chat_completion", payload: ["action": "streamed_chat_completion", "quest": .object(quest)]))
  }

  // MARK: - Sending

  func testSendShowsTheUserBubbleAndAcceptsTheQuestID() async throws {
    let model = makeModel(realtime: FakeRealtime())
    model.draft = "  Plan a trip  "

    await model.send()

    let sent = await api.sentMessages
    XCTAssertEqual(sent, [ChatSendRequest(message: "Plan a trip", target: .session("s1"))])
    XCTAssertEqual(model.draft, "")
    XCTAssertEqual(model.liveTurns.map(\.id), ["quest-1"])
    let messages = model.messages
    XCTAssertEqual(messages.first?.role, .user)
    XCTAssertEqual(messages.first?.text, "Plan a trip")
    XCTAssertEqual(messages.last?.badge, .queued, "the pending reply has a home for its badge")
    model.stop()
  }

  func testEmptyDraftSendsNothing() async {
    let model = makeModel(realtime: nil)
    model.draft = "   "
    XCTAssertFalse(model.canSend)
    await model.send()
    let sent = await api.sentMessages
    XCTAssertTrue(sent.isEmpty)
  }

  func testFailedSendIsShownAndRetryable() async throws {
    await api.setSendResult(.failure(.offline))
    let model = makeModel(realtime: FakeRealtime())
    model.draft = "Hi"

    await model.send()

    let failed = try XCTUnwrap(model.liveTurns.first)
    XCTAssertEqual(model.sendFailure(forQuestID: failed.id), .offline)
    XCTAssertEqual(model.hapticTrigger?.haptic, .failed)

    await api.setSendResult(.success(ChatSendReceipt(questID: "quest-2", sessionID: "s1")))
    await model.retry(questID: failed.id)

    XCTAssertNil(model.sendFailure(forQuestID: failed.id))
    XCTAssertEqual(model.liveTurns.map(\.id), ["quest-2"])
    XCTAssertEqual(model.liveTurns.first?.prompt, "Hi")
    model.stop()
  }

  func testOutOfCreditsRefusalGetsTheDistinctBadge() async {
    await api.setSendResult(
      .success(
        ChatSendReceipt(
          questID: "q", sessionID: "s1", kind: .error, errorCode: .insufficientCredits, message: "Not enough credits")))
    let model = makeModel(realtime: FakeRealtime())
    model.draft = "Write a book"

    await model.send()

    let reply = model.messages.last
    XCTAssertEqual(reply?.role, .assistant)
    XCTAssertEqual(reply?.text, "Not enough credits")
    XCTAssertEqual(reply?.badge, .outOfCredits(.insufficientCredits))
  }

  // MARK: - Streaming

  func testFramesReplaceTheReplyAndDriveHaptics() async {
    let model = makeModel(realtime: FakeRealtime())
    model.draft = "Hi"
    await model.send()

    model.apply(frame(reply: "Hel"))
    XCTAssertEqual(model.hapticTrigger?.haptic, .started)
    model.apply(frame(reply: "Hello, wor"))
    model.apply(frame(reply: "Hello"))
    XCTAssertEqual(model.messages.last?.text, "Hello, wor", "running text never shrinks mid-stream")

    model.apply(frame(reply: "Hello there", status: .done))
    XCTAssertEqual(model.messages.last?.text, "Hello there")
    XCTAssertNil(model.messages.last?.badge)
    XCTAssertEqual(model.hapticTrigger?.haptic, .finished)

    model.apply(frame(reply: "Hel", status: .running))
    XCTAssertEqual(model.messages.last?.text, "Hello there", "a straggler cannot reopen a settled turn")
    model.stop()
  }

  func testFramesForOtherSessionsAreIgnored() async throws {
    let realtime = FakeRealtime()
    let model = makeModel(realtime: realtime)
    let listener = Task { await model.listen() }
    await eventually { await realtime.listenerCount == 1 }

    await realtime.emit(streamedEvent(frame("other-quest", session: "s2", reply: "not for this screen")))
    await realtime.emit(.frame(ActionFrame(action: "agent_text_delta", payload: ["delta": "x"])))
    await realtime.emit(streamedEvent(frame("quest-9", reply: "for this screen", prompt: "from the web")))

    await eventually { await MainActor.run { model.liveTurns.count == 1 } }
    XCTAssertEqual(model.liveTurns.first?.id, "quest-9")
    XCTAssertEqual(model.messages.map(\.text), ["from the web", "for this screen"])
    listener.cancel()
  }

  /// The staging delivery path: status frames with no text, then one final frame whose text is only in
  /// `replies`. The reply must show while the screen stays open, and end on the server's own reply text.
  func testAFinalFrameWithTextOnlyInRepliesShowsTheReplyLive() async throws {
    let realtime = FakeRealtime()
    let model = makeModel(realtime: realtime)
    model.draft = "Name two colors"
    await model.send()
    let listener = Task { await model.listen() }
    await eventually { await realtime.listenerCount == 1 }

    func quest(_ fields: JSONObject) -> RealtimeEvent {
      var quest: JSONObject = ["id": "quest-1", "sessionId": "s1", "type": "message", "prompt": "Name two colors"]
      quest.merge(fields) { _, new in new }
      return .frame(
        ActionFrame(
          action: "streamed_chat_completion", payload: ["action": "streamed_chat_completion", "quest": .object(quest)]))
    }
    await api.setPolledQuests([
      QuestTurn(
        id: "quest-1", prompt: nil, reply: "Red and blue.", status: .done, createdAt: Samples.date, creditsUsed: 2)
    ])
    await realtime.emit(quest(["reply": .null, "replies": [], "status": "running", "creditsUsed": 0]))
    await realtime.emit(
      quest(["reply": .null, "replies": ["", "Red\nBlue"], "status": "done", "creditsUsed": 2]))

    await eventually { await MainActor.run { model.messages.last?.text == "Red and blue." } }
    XCTAssertEqual(model.messages.map(\.role), [.user, .assistant])
    XCTAssertEqual(model.liveTurns.first?.creditsUsed, 2)
    let lookups = await api.questLookups
    XCTAssertEqual(lookups.filter { $0 == "quest-1" }.count, 1, "the settled quest is fetched once")
    listener.cancel()
    model.stop()
  }

  func testASettledTurnKeepsTheFrameTextWhenTheFetchFails() async throws {
    let model = makeModel(realtime: FakeRealtime())
    model.apply(frame(reply: "Hello there", status: .done, prompt: "Hi"))
    let api = self.api!
    await eventually { await api.questLookups.contains("quest-1") }
    XCTAssertEqual(model.messages.last?.text, "Hello there")
    model.stop()
  }

  func testASettleCancelledByStopIsRetriedByALaterTerminalFrame() async throws {
    let model = makeModel(realtime: FakeRealtime())
    let api = self.api!
    model.apply(frame(reply: "Hello there", status: .done, prompt: "Hi"))
    model.stop()
    await eventually { await api.questLookups.contains("quest-1") }

    model.apply(frame(reply: "Hello there", status: .done, prompt: "Hi"))
    await eventually { await api.questLookups.filter { $0 == "quest-1" }.count == 2 }
    let lookups = await api.questLookups.filter { $0 == "quest-1" }
    XCTAssertEqual(lookups.count, 2)
    model.stop()
  }

  func testAFrameThatBeatsTheReceiptIsAdoptedNotDuplicated() async {
    await api.holdSends()
    let model = makeModel(realtime: FakeRealtime())
    model.draft = "Hi"
    let send = Task { await model.send() }
    let api = self.api!
    await eventually { await api.sentMessages.count == 1 }

    model.apply(frame("quest-1", reply: "Hel", prompt: "Hi"))
    XCTAssertEqual(model.liveTurns.map(\.id), ["quest-1"], "the frame took over the optimistic turn")
    await api.releaseSends()
    await send.value

    XCTAssertEqual(model.liveTurns.map(\.id), ["quest-1"])
    XCTAssertEqual(model.messages.map(\.text), ["Hi", "Hel"])
    model.stop()
  }

  func testAPromptlessFrameDoesNotClaimTheOptimisticTurn() async {
    await api.holdSends()
    let model = makeModel(realtime: FakeRealtime())
    model.draft = "Hi"
    let send = Task { await model.send() }
    let api = self.api!
    await eventually { await api.sentMessages.count == 1 }

    model.apply(frame("quest-other", reply: "from another device"))
    XCTAssertEqual(model.liveTurns.count, 2, "a frame without a prompt cannot be proven to be ours")
    XCTAssertTrue(model.liveTurns.contains { $0.id.hasPrefix("local-") })
    await api.releaseSends()
    await send.value
    model.stop()
  }

  func testPendingActionFrameMarksApprovalAndTicks() async {
    let model = makeModel(realtime: FakeRealtime())
    model.draft = "Book it"
    await model.send()
    model.apply(frame(reply: "", status: .running))

    let action = PendingAction(tool: "web_browse", parameters: ["url": "https://x.test"], requestedAt: clock.now)
    model.apply(frame(reply: "", status: .running, pendingAction: action))

    XCTAssertEqual(model.messages.last?.badge, .awaitingApproval)
    XCTAssertEqual(model.hapticTrigger?.haptic, .needsAttention)
    XCTAssertEqual(ApprovalState(turn: model.liveTurns[0], at: clock.now), .awaiting(action))
    model.stop()
  }

  // MARK: - Fallback

  func testPollsTheQuestWhileTheSocketIsDown() async throws {
    await api.setPolledQuests([
      QuestTurn(id: "quest-1", prompt: nil, reply: "Hi", status: .running, createdAt: Samples.date),
      QuestTurn(id: "quest-1", prompt: nil, reply: "Hi there", status: .done, createdAt: Samples.date),
    ])
    let model = makeModel(realtime: FakeRealtime(state: .waitingToReconnect(attempt: 0)))
    model.draft = "Hello"

    await model.send()

    await eventually { await MainActor.run { model.liveTurns.first?.status == .done } }
    XCTAssertEqual(model.liveTurns.first?.reply, "Hi there")
    XCTAssertEqual(model.liveTurns.first?.prompt, "Hello", "a poll does not carry the prompt; it is kept")
    let lookups = await api.questLookups
    XCTAssertEqual(lookups, ["quest-1", "quest-1"])
    try await Task.sleep(for: .milliseconds(50))
    let after = await api.questLookups
    XCTAssertEqual(after.count, 2, "polling stops once the quest settles")
  }

  func testDoesNotPollWhileTheSocketIsDelivering() async throws {
    let realtime = FakeRealtime(state: .connected)
    let model = makeModel(realtime: realtime)
    let listener = Task { await model.listen() }
    await eventually { await realtime.listenerCount == 1 }
    await eventually { await MainActor.run { model.isRealtimeConnected } }

    model.draft = "Hello"
    await model.send()
    try await Task.sleep(for: .milliseconds(50))
    let lookups = await api.questLookups
    XCTAssertTrue(lookups.isEmpty, "a connected socket that is hearing about the quest is trusted")

    model.apply(frame(reply: "Done", status: .done))
    listener.cancel()
    model.stop()
  }

  func testPollingIsBounded() async throws {
    await api.setPolledQuests([
      QuestTurn(id: "quest-1", prompt: nil, reply: "", status: .running, createdAt: Samples.date)
    ])
    let model = makeModel(realtime: nil, maxPolls: 3)
    model.draft = "Hello"

    await model.send()

    let api = self.api!
    await eventually { await api.questLookups.count == 3 }
    try await Task.sleep(for: .milliseconds(50))
    let lookups = await api.questLookups
    XCTAssertEqual(lookups.count, 3)
  }

  func testReconnectRefetchesTheTranscriptAndSettlesLiveTurns() async throws {
    let realtime = FakeRealtime()
    let model = makeModel(realtime: realtime)
    let listener = Task { await model.listen() }
    await eventually { await realtime.listenerCount == 1 }
    model.draft = "Hello"
    await model.send()
    model.apply(frame(reply: "Hel"))

    await api.setQuestPages([
      nil: Page(
        items: [Samples.quest("quest-1", prompt: "Hello", reply: "Hello world", status: .done)], nextCursor: nil)
    ])
    await api.setPolledQuests([
      QuestTurn(id: "quest-1", prompt: nil, reply: "Hello world", status: .done, createdAt: Samples.date)
    ])
    await realtime.emit(.refetchNeeded)

    await eventually { await MainActor.run { model.messages.last?.text == "Hello world" } }
    XCTAssertEqual(model.messages.count, 2)
    listener.cancel()
    model.stop()
  }
}
