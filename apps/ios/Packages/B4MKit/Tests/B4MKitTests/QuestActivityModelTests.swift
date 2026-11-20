import XCTest

@testable import B4MKit

final class QuestActivityContentStateTests: XCTestCase {
  private func decode(_ json: String) throws -> QuestActivityContentState {
    try JSONDecoder().decode(QuestActivityContentState.self, from: Data(json.utf8))
  }

  func testDecodesTheServerPayloadExactly() throws {
    let state = try decode(
      #"{"status":"approval_needed","stageLabel":"Waiting for your approval","progress":0.25,"errored":false}"#)
    XCTAssertEqual(state.status, "approval_needed")
    XCTAssertEqual(state.phase, .approvalNeeded)
    XCTAssertEqual(state.stageLabel, "Waiting for your approval")
    XCTAssertEqual(state.progress, 0.25)
    XCTAssertEqual(state.errored, false)
  }

  func testOptionalKeysMayBeAbsent() throws {
    let state = try decode(#"{"status":"running"}"#)
    XCTAssertEqual(state, QuestActivityContentState(phase: .running))
    XCTAssertNil(state.stageLabel)
    XCTAssertNil(state.progress)
    XCTAssertNil(state.errored)
  }

  func testEveryServerStatusMapsToItsPhase() {
    let expected: [(String, QuestRunPhase)] = [
      ("running", .running), ("paused", .paused), ("approval_needed", .approvalNeeded),
      ("completed", .completed), ("failed", .failed), ("stopped", .stopped),
    ]
    for (wire, phase) in expected {
      XCTAssertEqual(QuestRunPhase(wire: wire), phase, wire)
      XCTAssertEqual(phase.rawValue, wire)
    }
  }

  func testUnknownStatusIsTreatedAsRunningAndSurvivesARoundTrip() throws {
    let state = try decode(#"{"status":"warming_up","stageLabel":"Hold on"}"#)
    XCTAssertEqual(state.phase, .running)
    XCTAssertFalse(state.phase.isTerminal)
    let again = try JSONDecoder().decode(QuestActivityContentState.self, from: JSONEncoder().encode(state))
    XCTAssertEqual(again.status, "warming_up")
  }

  func testOnlyCompletedFailedAndStoppedAreTerminal() {
    XCTAssertEqual(QuestRunPhase.allCases.filter(\.isTerminal), [.completed, .failed, .stopped])
  }

  func testEncodesExactlyTheWireKeysAndOmitsNil() throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    let full = try encoder.encode(
      QuestActivityContentState(status: "running", stageLabel: "Using web_search", progress: 0.5, errored: true))
    XCTAssertEqual(
      String(decoding: full, as: UTF8.self),
      #"{"errored":true,"progress":0.5,"stageLabel":"Using web_search","status":"running"}"#)
    let bare = try encoder.encode(QuestActivityContentState(phase: .completed))
    XCTAssertEqual(String(decoding: bare, as: UTF8.self), #"{"status":"completed"}"#)
  }

  func testProgressIsClampedForDrawing() {
    XCTAssertEqual(QuestActivityContentState(phase: .running, progress: 1.4).progressFraction, 1)
    XCTAssertEqual(QuestActivityContentState(phase: .running, progress: -0.2).progressFraction, 0)
    XCTAssertNil(QuestActivityContentState(phase: .running, progress: .nan).progressFraction)
    XCTAssertNil(QuestActivityContentState(phase: .running).progressFraction)
  }

  func testAttributesCarryTheFixedFields() throws {
    let attributes = QuestActivityAttributes(
      questId: "q1", sessionId: "s1", title: "Trip", startedAt: Date(timeIntervalSince1970: 100))
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    let object = try XCTUnwrap(
      JSONSerialization.jsonObject(with: encoder.encode(attributes)) as? [String: Any])
    XCTAssertEqual(Set(object.keys), ["questId", "sessionId", "title", "startedAt"])
    XCTAssertEqual(try JSONDecoder().decode(QuestActivityAttributes.self, from: encoder.encode(attributes)), attributes)
  }
}

final class QuestActivityMappingTests: XCTestCase {
  private func frame(
    status: QuestTurn.Status? = .running, kind: QuestTurn.Kind? = .message, pending: Bool = false,
    message: String? = nil
  ) -> ChatQuestFrame {
    ChatQuestFrame(
      questID: "q1", sessionID: "s1", reply: nil, status: status, kind: kind,
      pendingAction: pending ? PendingAction(tool: "web_browse", parameters: [:], requestedAt: Date()) : nil,
      statusMessage: message)
  }

  func testProgressTextBecomesTheRunningStageLabel() {
    XCTAssertEqual(
      QuestActivityMapping.state(from: frame(message: "  Searching your notes ")),
      QuestActivityContentState(phase: .running, stageLabel: "Searching your notes"))
  }

  func testAFrameWithoutProgressTextIsRunningWithNoLabel() {
    XCTAssertEqual(QuestActivityMapping.state(from: frame()), QuestActivityContentState(phase: .running))
    XCTAssertEqual(
      QuestActivityMapping.state(from: frame(message: "   ")), QuestActivityContentState(phase: .running))
  }

  func testStageLabelsAreCappedAtSixtyCharacters() throws {
    let state = QuestActivityMapping.state(from: frame(message: String(repeating: "a", count: 90)))
    XCTAssertEqual(try XCTUnwrap(state.stageLabel).count, 60)
    XCTAssertTrue(try XCTUnwrap(state.stageLabel).hasSuffix("..."))
  }

  func testAPendingActionIsApprovalNeeded() {
    XCTAssertEqual(
      QuestActivityMapping.state(from: frame(pending: true, message: "ignored while waiting")),
      QuestActivityContentState(phase: .approvalNeeded, stageLabel: "Waiting for your approval"))
  }

  func testTerminalFramesMapToCompletedStoppedAndFailed() {
    XCTAssertEqual(QuestActivityMapping.state(from: frame(status: .done)).phase, .completed)
    XCTAssertEqual(QuestActivityMapping.state(from: frame(status: .stopped)).phase, .stopped)
    let failed = QuestActivityMapping.state(from: frame(status: .stopped, kind: .error))
    XCTAssertEqual(failed, QuestActivityContentState(phase: .failed, errored: true))
  }

  func testATerminalStatusBeatsAStalePendingAction() {
    XCTAssertEqual(QuestActivityMapping.state(from: frame(status: .done, pending: true)).phase, .completed)
  }

  func testTurnMappingAgreesWithFrameMapping() {
    let pending = PendingAction(tool: "web_browse", parameters: [:], requestedAt: Date())
    let cases: [(QuestTurn, ChatQuestFrame)] = [
      (QuestTurn(id: "q1", prompt: nil, reply: nil, status: .running, createdAt: Date()), frame()),
      (QuestTurn(id: "q1", prompt: nil, reply: nil, status: .done, createdAt: Date()), frame(status: .done)),
      (QuestTurn(id: "q1", prompt: nil, reply: nil, status: .stopped, createdAt: Date()), frame(status: .stopped)),
      (
        QuestTurn(id: "q1", prompt: nil, reply: nil, status: .stopped, kind: .error, createdAt: Date()),
        frame(status: .stopped, kind: .error)
      ),
      (
        QuestTurn(id: "q1", prompt: nil, reply: nil, status: .pending, createdAt: Date(), pendingAction: pending),
        frame(pending: true)
      ),
    ]
    for (turn, frame) in cases {
      XCTAssertEqual(QuestActivityMapping.state(from: turn), QuestActivityMapping.state(from: frame))
    }
  }

  func testAgentRunStatesMapLikeTheWorker() {
    func state(_ run: AgentRunStatus.State, steps: [AgentRunStatus.Step] = []) -> QuestActivityContentState {
      QuestActivityMapping.state(from: AgentRunStatus(id: "e1", state: run, steps: steps))
    }
    XCTAssertEqual(state(.completed), QuestActivityContentState(phase: .completed))
    XCTAssertEqual(state(.failed), QuestActivityContentState(phase: .failed, errored: true))
    XCTAssertEqual(state(.aborted), QuestActivityContentState(phase: .stopped))
    XCTAssertEqual(
      state(.awaitingPermission),
      QuestActivityContentState(phase: .approvalNeeded, stageLabel: "Waiting for your approval"))
    XCTAssertEqual(
      state(.paused), QuestActivityContentState(phase: .paused, stageLabel: "Waiting for your input"))
    for running in [AgentRunStatus.State.pending, .running, .continuing, .awaitingSubagent, .awaitingDagChildren] {
      XCTAssertEqual(state(running).phase, .running, "\(running)")
    }
  }

  func testRunStageLabelFollowsTheLatestToolStep() {
    let search = AgentRunStatus.Step(type: .action, toolName: "web_search")
    let seen = AgentRunStatus.Step(type: .observation)
    let thought = AgentRunStatus.Step(type: .thought)
    func label(_ steps: [AgentRunStatus.Step]) -> String? {
      QuestActivityMapping.state(from: AgentRunStatus(id: "e1", state: .running, steps: steps)).stageLabel
    }
    XCTAssertNil(label([thought]))
    XCTAssertEqual(label([thought, search]), "Using web_search")
    XCTAssertEqual(label([search, seen, thought]), "Finished web_search")
    XCTAssertEqual(label([search, seen, AgentRunStatus.Step(type: .action, toolName: "write")]), "Using write")
  }

  func testUnknownRunStatusReadsAsRunning() {
    XCTAssertEqual(AgentRunStatus.State(wire: "queued_for_gpu"), .running)
  }

  func testPresentationMakesOnlyApprovalUrgent() {
    for phase in QuestRunPhase.allCases {
      let presentation = QuestActivityPresentation(QuestActivityContentState(phase: phase, progress: 0.5))
      XCTAssertEqual(presentation.isUrgent, phase == .approvalNeeded, "\(phase)")
      XCTAssertEqual(presentation.isTerminal, phase.isTerminal)
      XCTAssertEqual(presentation.progress == nil, phase.isTerminal, "terminal states drop the bar: \(phase)")
    }
    let approval = QuestActivityPresentation(QuestActivityContentState(phase: .approvalNeeded))
    XCTAssertEqual(approval.statusText, "Approval needed")
    XCTAssertEqual(approval.tone, .attention)
    XCTAssertEqual(
      QuestActivityPresentation(QuestActivityContentState(phase: .running, stageLabel: "Using web_search")).detail,
      "Using web_search")
    XCTAssertEqual(QuestActivityPresentation(.previewCompleted).tone, .success)
    XCTAssertEqual(QuestActivityPresentation(.previewFailed).tone, .failure)
    XCTAssertEqual(QuestActivityPresentation(.previewStopped).statusText, "Stopped")
  }

  func testPromptTitlesAreCollapsedAndCapped() {
    XCTAssertEqual(QuestActivityTitle.fromPrompt("  Plan   a\ntrip  "), "Plan a trip")
    XCTAssertEqual(QuestActivityTitle.fromPrompt(""), "Bike4Mind")
    XCTAssertEqual(QuestActivityTitle.fromPrompt(String(repeating: "x", count: 100)).count, 40)
  }
}
