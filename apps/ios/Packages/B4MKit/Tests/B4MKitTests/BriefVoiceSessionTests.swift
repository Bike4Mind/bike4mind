import XCTest

@testable import B4MKit

private actor VoiceBriefAPI: BriefAPI {
  private var current: Result<Brief, APIError>
  private var replyFailure: BriefReplyFailure?
  private(set) var replies: [(decisionID: String, text: String, choiceIndex: Int?)] = []

  init(_ current: Result<Brief, APIError>) { self.current = current }

  func failReplies(with failure: BriefReplyFailure) { replyFailure = failure }
  func set(_ brief: Brief) { current = .success(brief) }
  func compose() async throws -> Brief { try current.get() }
  func list() async throws -> [Brief] { [try current.get()] }
  func brief(id: String) async throws -> Brief { try current.get() }

  func reply(briefID: String, decisionID: String, text: String, choiceIndex: Int?) async throws -> BriefReplyResult {
    replies.append((decisionID, text, choiceIndex))
    if let replyFailure { throw replyFailure }
    return BriefReplyResult(executionID: "e1", sessionID: "s1")
  }
}

private actor VoicePendingAPI: PendingActionAPI {
  private var failure: PendingActionFailure?
  private(set) var calls: [PendingActionDecision] = []

  func fail(with failure: PendingActionFailure) { self.failure = failure }

  func respond(to target: PendingActionTarget, decision: PendingActionDecision) async throws -> PendingActionResult {
    calls.append(decision)
    if let failure { throw failure }
    return PendingActionResult(decision: decision)
  }
}

private func brief(_ decisions: [BriefDecision], headline: String = "A quiet day") -> Brief {
  let now = Date(timeIntervalSince1970: 1_700_000_000)
  return Brief(
    id: "b1", status: .ready, createdAt: now, periodStart: now, periodEnd: now, headline: headline,
    decisions: decisions)
}

private func approval(_ id: String, _ text: String, _ state: BriefApprovalState = .pending) -> BriefDecision {
  BriefDecision(
    id: id, text: text, approval: BriefApprovalRef(questID: "q", sessionID: "s", pendingActionTs: 1, state: state))
}

private func question(_ id: String, _ text: String, options: [String] = []) -> BriefDecision {
  BriefDecision(
    id: id, text: text, question: BriefQuestionRef(questID: "qq", sessionID: "s", options: options, state: .open))
}

@MainActor
final class BriefVoiceSessionTests: XCTestCase {
  private func make(
    _ fetched: Result<Brief, APIError>
  ) -> (BriefVoiceSession, VoiceBriefAPI, VoicePendingAPI) {
    let api = VoiceBriefAPI(fetched)
    let pending = VoicePendingAPI()
    return (BriefVoiceSession(briefID: "b1", api: api, pendingActions: pending), api, pending)
  }

  func testPrepareSpeaksTheBriefAndSeedsTheFirstTurnWithIt() async {
    let (session, _, _) = make(.success(brief([approval("d1", "Ship the release")])))
    let (opening, context) = await session.prepare()
    XCTAssertEqual(opening, ["A quiet day.", "One thing needs you. Ship the release. Approve or deny?"])
    XCTAssertEqual(context, opening.joined(separator: "\n"))
  }

  func testPrepareSaysTheBriefCouldNotLoadAndLeavesNoContext() async {
    let (session, _, _) = make(.failure(.malformedResponse))
    let (opening, context) = await session.prepare()
    XCTAssertEqual(opening, [BriefVoiceSession.loadFailure])
    XCTAssertNil(context)
  }

  private func loaded(_ decisions: [BriefDecision]) async -> (BriefVoiceSession, VoiceBriefAPI, VoicePendingAPI) {
    let made = make(.success(brief(decisions)))
    _ = await made.0.prepare()
    return made
  }

  func testParsesOnlyPlainCommands() {
    let options = ["Main hall", "Garden"]
    let table: [(String, BriefVoiceCommand?)] = [
      ("", nil), ("  ", nil), ("Approve.", .approve), ("approve that one", .approve), ("Deny!", .deny),
      ("reject it", .deny), ("Yes", .confirm), ("no", .cancel), ("Archive it", .archive),
      ("don't approve", nil), ("approve the budget but not the travel", nil),
      ("Reply: the main hall", .reply("the main hall")),
      ("answer tomorrow at 3", .reply("tomorrow at 3")), ("reply", nil), ("garden.", .choose(1)),
      ("main hall", .choose(0)), ("the pool", nil), ("what's next", nil),
    ]
    for (utterance, expected) in table {
      XCTAssertEqual(BriefVoiceCommand.parse(utterance, options: options), expected, utterance)
    }
  }

  func testApproveAsksForConfirmationAndYesApproves() async {
    let (session, _, pending) = await loaded([approval("d1", "Ship the **release**.")])
    let ask = await session.handle("approve")
    XCTAssertEqual(ask, "Approve Ship the release? Say yes to confirm.")
    var calls = await pending.calls
    XCTAssertTrue(calls.isEmpty)
    let done = await session.handle("yes")
    XCTAssertEqual(done, "Approved. That's everything.")
    calls = await pending.calls
    XCTAssertEqual(calls, [.approve])
  }

  func testAnyOtherUtteranceDisarmsTheConfirmation() async {
    let (session, _, pending) = await loaded([approval("d1", "Ship it")])
    _ = await session.handle("approve")
    let chat = await session.handle("what does it change")
    XCTAssertNil(chat)
    let stray = await session.handle("yes")
    XCTAssertNil(stray)
    let calls = await pending.calls
    XCTAssertTrue(calls.isEmpty)
  }

  func testNoCancelsAndRepeatsThePrompt() async {
    let (session, _, pending) = await loaded([approval("d1", "Ship it")])
    _ = await session.handle("approve")
    let cancelled = await session.handle("no")
    XCTAssertEqual(cancelled, "Okay, not approved. Ship it. Approve or deny?")
    let calls = await pending.calls
    XCTAssertTrue(calls.isEmpty)
  }

  func testDenyAnswersAtOnceAndMovesToTheNextDecision() async {
    let (session, _, pending) = await loaded([
      approval("d1", "Ship it"), question("d2", "Which venue?", options: ["Hall", "Garden"]),
    ])
    let spoken = await session.handle("deny")
    XCTAssertEqual(spoken, "Denied. Next: Which venue? Options: Hall or Garden.")
    let calls = await pending.calls
    XCTAssertEqual(calls, [.deny])
  }

  func testRepliesAndChoicesGoToTheQuestion() async {
    let (session, api, _) = await loaded([question("d1", "Which venue?", options: ["Hall"]), question("d2", "When?")])
    let chose = await session.handle("hall")
    XCTAssertEqual(chose, "Reply sent. Next: When? Say reply and your answer.")
    let replied = await session.handle("reply Friday at noon")
    XCTAssertEqual(replied, "Reply sent. That's everything.")
    let replies = await api.replies
    XCTAssertEqual(replies.map(\.decisionID), ["d1", "d2"])
    XCTAssertEqual(replies.map(\.text), ["Hall", "Friday at noon"])
    XCTAssertEqual(replies.map(\.choiceIndex), [0, nil])
  }

  func testACommandForTheWrongKindOfDecisionIsRedirected() async {
    let (approvalSession, _, _) = await loaded([approval("d1", "Ship it")])
    let onApproval = await approvalSession.handle("reply sure")
    XCTAssertEqual(onApproval, "Say approve or deny.")
    let (questionSession, _, _) = await loaded([question("d1", "When?")])
    let onQuestion = await questionSession.handle("approve")
    XCTAssertEqual(onQuestion, "That one is a question. Say reply and your answer.")
  }

  func testAFailureIsSpokenOnceAndASettledOneMovesOn() async {
    let (session, _, pending) = await loaded([approval("d1", "Ship it"), question("d2", "When?")])
    await pending.fail(with: .unavailable)
    let failed = await session.handle("deny")
    XCTAssertEqual(failed, PendingActionFailure.unavailable.message)
    let moved = await session.handle("deny")
    XCTAssertEqual(moved, "That one is a question. Say reply and your answer.")
  }

  func testAnApprovalAnsweredElsewhereSaysSoAndOffersTheNext() async {
    let (session, api, pending) = await loaded([approval("d1", "Ship it"), approval("d2", "Pay the invoice")])
    await api.set(brief([approval("d1", "Ship it", .approved), approval("d2", "Pay the invoice")]))
    await pending.fail(with: .alreadyResolved)
    let stale = await session.handle("deny")
    XCTAssertEqual(stale, "That one was already answered. Next: Pay the invoice. Approve or deny?")
  }

  func testAReplyFailureIsSpoken() async {
    let (session, api, _) = await loaded([question("d1", "When?")])
    await api.failReplies(with: .invalid)
    let spoken = await session.handle("reply soon")
    XCTAssertEqual(spoken, BriefReplyFailure.invalid.message)
  }

  func testArchiveIsRefusedEvenWithNothingPendingAndOtherWordsGoToTheChat() async {
    let (session, _, _) = await loaded([approval("d1", "Ship it", .approved)])
    let archive = await session.handle("archive")
    XCTAssertEqual(archive, BriefVoiceSession.archiveRefusal)
    let approve = await session.handle("approve")
    XCTAssertNil(approve)
  }
}
