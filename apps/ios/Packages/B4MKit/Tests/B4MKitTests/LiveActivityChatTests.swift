import XCTest

@testable import B4MKit

/// The chat code reports what it sees to the activity tracker; these pin what it reports and when.
@MainActor
final class LiveActivityChatTests: XCTestCase {
  private var api: FakeAPI!
  private var tracker: RecordingTracker!
  private var starter: FakeAgentRunStarter!
  private var clock: TestClock!

  override func setUp() async throws {
    api = FakeAPI()
    tracker = RecordingTracker()
    starter = FakeAgentRunStarter()
    clock = TestClock()
  }

  private func makeModel(title: String = "Trip planning") -> ChatViewModel {
    ChatViewModel(
      sessionID: "s1", api: api, realtime: FakeRealtime(),
      sleep: { _ in try await Task.sleep(for: .milliseconds(1)) }, now: clock.provider, title: title,
      activities: tracker, agentRuns: starter)
  }

  private func frame(
    _ questID: String = "quest-1", status: QuestTurn.Status? = .running, message: String? = nil,
    pending: Bool = false, kind: QuestTurn.Kind? = nil, prompt: String? = nil
  ) -> ChatQuestFrame {
    ChatQuestFrame(
      questID: questID, sessionID: "s1", prompt: prompt, reply: "", status: status, kind: kind,
      pendingAction: pending ? PendingAction(tool: "web_browse", parameters: [:], requestedAt: clock.now) : nil,
      statusMessage: message)
  }

  // MARK: - Chat turns

  func testAnAcceptedSendStartsAnActivityForTheQuest() async {
    let model = makeModel()
    model.draft = "Plan a trip"
    await model.send()

    XCTAssertEqual(
      tracker.starts,
      [
        QuestActivityStart(
          questID: "quest-1", sessionID: "s1", title: "Trip planning", startedAt: clock.now,
          initialState: QuestActivityContentState(phase: .running))
      ])
    model.stop()
  }

  func testASessionWithoutANameTitlesTheActivityFromThePrompt() async {
    let model = makeModel(title: "")
    model.draft = "Plan a trip to Lisbon"
    await model.send()
    XCTAssertEqual(tracker.starts.first?.title, "Plan a trip to Lisbon")
    model.stop()
  }

  func testARefusedTurnNeverGetsAnActivity() async {
    await api.setSendResult(
      .success(
        ChatSendReceipt(
          questID: "quest-1", sessionID: "s1", kind: .error, errorCode: .insufficientCredits, message: "No credits")))
    let model = makeModel()
    model.draft = "hi"
    await model.send()
    XCTAssertTrue(tracker.calls.isEmpty)
    model.stop()
  }

  func testAFailedSendNeverGetsAnActivity() async {
    await api.setSendResult(.failure(.offline))
    let model = makeModel()
    model.draft = "hi"
    await model.send()
    XCTAssertTrue(tracker.calls.isEmpty)
    model.stop()
  }

  func testFramesAreReportedWithTheSameMappingTheServerUses() async {
    let model = makeModel()
    model.draft = "hi"
    await model.send()

    model.apply(frame(message: "Searching your notes"))
    model.apply(frame(pending: true))
    model.apply(frame(status: .done))

    XCTAssertEqual(
      tracker.changes.map(\.state),
      [
        QuestActivityContentState(phase: .running, stageLabel: "Searching your notes"),
        QuestActivityContentState(phase: .approvalNeeded, stageLabel: "Waiting for your approval"),
        QuestActivityContentState(phase: .completed),
      ])
    XCTAssertEqual(Set(tracker.changes.map(\.questID)), ["quest-1"])
    model.stop()
  }

  func testAnErrorFrameIsReportedAsFailed() async {
    let model = makeModel()
    model.draft = "hi"
    await model.send()
    model.apply(frame(status: .stopped, kind: .error))
    XCTAssertEqual(tracker.changes.last?.state, QuestActivityContentState(phase: .failed, errored: true))
    model.stop()
  }

  func testAFrameThatBeatsTheReceiptStillStartsTheActivityWithItsState() async {
    await api.holdSends()
    let model = makeModel()
    model.draft = "hi"
    let sending = Task { await model.send() }
    let api = self.api!
    await eventually { await api.sentMessages.count == 1 }

    model.apply(frame(message: "Reading your message", prompt: "hi"))
    await api.releaseSends()
    await sending.value

    XCTAssertEqual(tracker.starts.count, 1)
    XCTAssertEqual(tracker.starts.first?.questID, "quest-1")
    XCTAssertEqual(tracker.changes.first?.state.stageLabel, "Reading your message")
    model.stop()
  }

  func testAPolledTerminalStateReachesTheActivityToo() async throws {
    await api.setPolledQuests([
      QuestTurn(id: "quest-1", prompt: nil, reply: "done", status: .done, kind: .message, createdAt: clock.now)
    ])
    let model = makeModel()
    model.draft = "hi"
    await model.send()
    await waitUntil("the poll to report completion") { [tracker] in
      tracker!.changes.contains { $0.state.phase == .completed }
    }
    model.stop()
  }

  // MARK: - Agent runs

  func testSendingAsAnAgentRunStartsARunNotAChatTurn() async {
    let model = makeModel()
    model.sendsAsAgentRun = true
    model.draft = "Audit the data"
    await model.send()

    let requests = await starter.requests
    XCTAssertEqual(requests.map(\.sessionID), ["s1"])
    XCTAssertEqual(requests.map(\.title), ["Trip planning"])
    XCTAssertEqual(requests.map(\.message), ["Audit the data"])
    let chatSends = await api.sentMessages
    XCTAssertTrue(chatSends.isEmpty)
    XCTAssertEqual(model.liveTurns.map(\.id), ["quest-run-1"], "the optimistic turn adopts the run's quest")
    XCTAssertTrue(tracker.calls.isEmpty, "the run service owns the run's activity")
    XCTAssertFalse(model.sendsAsAgentRun, "the next message is a chat turn again")
    model.stop()
  }

  func testAFailedRunStartKeepsTheModeSoARetryIsStillARun() async {
    await starter.setResult(.failure(.server(status: 409)))
    let model = makeModel()
    model.sendsAsAgentRun = true
    model.draft = "Audit"
    await model.send()

    XCTAssertEqual(model.sendFailures.values.first, .server(status: 409))
    XCTAssertTrue(model.sendsAsAgentRun)
    let localID = try? XCTUnwrap(model.sendFailures.keys.first)

    await starter.setResult(.success(AgentRunReceipt(executionID: "e2", questID: "quest-run-2", sessionID: "s1")))
    await model.retry(questID: localID ?? "")
    let requests = await starter.requests
    XCTAssertEqual(requests.count, 2)
    XCTAssertEqual(model.liveTurns.map(\.id), ["quest-run-2"])
    model.stop()
  }

  func testWithoutARunServiceTheAgentToggleIsNotOffered() {
    let model = ChatViewModel(sessionID: "s1", api: api, realtime: FakeRealtime())
    XCTAssertFalse(model.canRunAgent)
    XCTAssertTrue(makeModel().canRunAgent)
  }

  // MARK: - New conversations

  func testANewConversationStartsItsActivityTitledFromTheFirstMessage() async {
    await api.setSendResult(.success(ChatSendReceipt(questID: "quest-7", sessionID: "new-session")))
    let model = NewConversationViewModel(draft: "Summarize my week", api: api, activities: tracker, now: clock.provider)

    let sessionID = await model.send()

    XCTAssertEqual(sessionID, "new-session")
    XCTAssertEqual(
      tracker.starts,
      [
        QuestActivityStart(
          questID: "quest-7", sessionID: "new-session", title: "Summarize my week", startedAt: clock.now,
          initialState: QuestActivityContentState(phase: .running))
      ])
  }

  func testARefusedNewConversationStartsNothing() async {
    await api.setSendResult(
      .success(ChatSendReceipt(questID: "quest-7", sessionID: "s", kind: .error, message: "No credits")))
    let model = NewConversationViewModel(draft: "hi", api: api, activities: tracker)
    _ = await model.send()
    XCTAssertTrue(tracker.calls.isEmpty)
  }
}
