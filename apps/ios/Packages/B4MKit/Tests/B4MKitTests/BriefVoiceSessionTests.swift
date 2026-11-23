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

  func fail(with failure: PendingActionFailure?) { self.failure = failure }

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
  private var canAnswer = true

  private func make(
    _ fetched: Result<Brief, APIError>
  ) -> (BriefVoiceSession, VoiceBriefAPI, VoicePendingAPI) {
    let api = VoiceBriefAPI(fetched)
    let pending = VoicePendingAPI()
    let session = BriefVoiceSession(
      briefID: "b1", api: api, pendingActions: pending, canAnswer: { [unowned self] in canAnswer })
    return (session, api, pending)
  }

  func testPrepareSpeaksTheBriefAndSeedsTheFirstTurnWithIt() async {
    let (session, _, _) = make(.success(brief([approval("d1", "Ship the release")])))
    let (opening, context) = await session.prepare()
    XCTAssertEqual(opening, ["A quiet day.", "One thing needs you. Ship the release. Approve or deny it?"])
    XCTAssertEqual(context, opening.joined(separator: "\n"))
  }

  func testPrepareCollectsTheOptionsItReadsOutAsAnswers() async {
    let (session, _, _) = make(
      .success(brief([approval("d1", "Ship it"), question("d2", "When?", options: ["**Next week**", "Never"])])))
    _ = await session.prepare()
    XCTAssertEqual(session.answerPhrases, ["Next week", "Never"])
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
      ("deny it approve", nil), ("yes no", nil), ("approve or deny", nil),
    ]
    for (utterance, expected) in table {
      XCTAssertEqual(BriefVoiceCommand.parse(utterance, options: options), expected, utterance)
    }
  }

  func testYesAndNoKeepTheirMeaningWhileAnAnswerWaits() {
    let options = ["Yes", "No"]
    XCTAssertEqual(BriefVoiceCommand.parse("yes", options: options), .choose(0))
    XCTAssertEqual(BriefVoiceCommand.parse("yes", options: options, confirming: .answer), .confirm)
    XCTAssertEqual(BriefVoiceCommand.parse("no", options: options, confirming: .answer), .cancel)
    XCTAssertNil(BriefVoiceCommand.parse("yes no", options: options, confirming: .answer))
  }

  func testAYesOptionCanBeChosenAndThenConfirmed() async {
    let (session, api, _) = await loaded([question("d1", "Go ahead?", options: ["Yes", "No"])])
    let chose = await session.handle("yes")
    XCTAssertEqual(chose, "Choose Yes? Say yes to send it.")
    let sent = await session.handle("yes")
    XCTAssertEqual(sent, "Reply sent. That's everything.")
    let replies = await api.replies
    XCTAssertEqual(replies.map(\.text), ["Yes"])
  }

  func testNoCancelsAnArmedReplyRatherThanChoosingTheNoOption() async {
    let (session, api, _) = await loaded([question("d1", "Go ahead?", options: ["Yes", "No"])])
    _ = await session.handle("reply after lunch")
    let cancelled = await session.handle("no")
    XCTAssertEqual(cancelled?.hasPrefix("Okay, not sent."), true)
    let replies = await api.replies
    XCTAssertTrue(replies.isEmpty)
  }

  func testMixedCommandWordsAnswerNothing() async {
    let (session, _, pending) = await loaded([approval("d1", "Ship it")])
    let heard = await session.handle("deny it approve")
    XCTAssertNil(heard)
    let calls = await pending.calls
    XCTAssertTrue(calls.isEmpty)
  }

  func testApproveAndDenyAnswerAWaitingConfirmation() {
    for (utterance, expected) in [
      ("yes approve", BriefVoiceCommand.confirm), ("yes I approve", .confirm), ("approve", .confirm),
      ("no, deny it", .cancel), ("deny", .cancel), ("no don't approve", nil), ("yes deny", nil),
    ] {
      XCTAssertEqual(BriefVoiceCommand.parse(utterance, confirming: .approval), expected, utterance)
    }
    XCTAssertNil(BriefVoiceCommand.parse("yes approve"))
    XCTAssertEqual(BriefVoiceCommand.parse("approve", confirming: .answer), .approve)
  }

  func testAnApproveOptionIsChosenWhileAnotherChoiceWaits() async {
    let (session, api, _) = await loaded([question("d1", "Ship it?", options: ["Approve", "Reject"])])
    _ = await session.handle("reject")
    let rechose = await session.handle("approve")
    XCTAssertEqual(rechose, "Choose Approve? Say yes to send it.")
    var replies = await api.replies
    XCTAssertTrue(replies.isEmpty)
    _ = await session.handle("yes")
    replies = await api.replies
    XCTAssertEqual(replies.map(\.text), ["Approve"])
  }

  func testAWholeMultiWordOptionIsChosenWhileAnotherWaits() async {
    XCTAssertEqual(
      BriefVoiceCommand.parse("no preference", options: ["No preference", "Garden"], confirming: .answer),
      .choose(0))
    let (session, api, _) = await loaded([question("d1", "Ship it?", options: ["Yes, ship it", "No, wait"])])
    _ = await session.handle("no wait")
    let rechose = await session.handle("yes ship it")
    XCTAssertEqual(rechose, "Choose Yes, ship it? Say yes to send it.")
    var replies = await api.replies
    XCTAssertTrue(replies.isEmpty)
    _ = await session.handle("yes")
    replies = await api.replies
    XCTAssertEqual(replies.map(\.text), ["Yes, ship it"])
  }

  func testApproveOrDenyKeepsAnArmedReplyOnAQuestion() async {
    let (session, api, _) = await loaded([question("d1", "When?")])
    _ = await session.handle("reply after lunch")
    let approve = await session.handle("approve")
    XCTAssertEqual(approve, "Say yes to send it or no to cancel.")
    let deny = await session.handle("deny")
    XCTAssertEqual(deny, "Say yes to send it or no to cancel.")
    _ = await session.handle("yes")
    let replies = await api.replies
    XCTAssertEqual(replies.map(\.text), ["after lunch"])
  }

  func testMixedCommandWordsKeepTheArmedAnswer() async {
    let (session, api, pending) = await loaded([question("d1", "When?"), approval("d2", "Ship it")])
    _ = await session.handle("reply after lunch")
    for utterance in ["yes approve", "no deny"] {
      let kept = await session.handle(utterance)
      XCTAssertEqual(kept, "Say yes to send it or no to cancel.", utterance)
    }
    _ = await session.handle("yes")
    let replies = await api.replies
    XCTAssertEqual(replies.map(\.text), ["after lunch"])
    _ = await session.handle("approve")
    let kept = await session.handle("yes deny")
    XCTAssertEqual(kept, "Say yes to approve it or no to cancel.")
    var calls = await pending.calls
    XCTAssertTrue(calls.isEmpty)
    let done = await session.handle("yes")
    XCTAssertEqual(done?.hasPrefix("Approved."), true)
    calls = await pending.calls
    XCTAssertEqual(calls, [.approve])
  }

  func testYesApproveConfirmsAndNoDenyItCancels() async {
    let (session, _, pending) = await loaded([approval("d1", "Ship it"), approval("d2", "Merge it")])
    _ = await session.handle("approve")
    let done = await session.handle("yes, I approve")
    XCTAssertEqual(done?.hasPrefix("Approved."), true)
    _ = await session.handle("approve")
    let cancelled = await session.handle("no, deny it")
    XCTAssertEqual(cancelled?.hasPrefix("Okay, not approved."), true)
    let calls = await pending.calls
    XCTAssertEqual(calls, [.approve])
  }

  func testApproveAsksForConfirmationAndYesApproves() async {
    let (session, _, pending) = await loaded([approval("d1", "Ship the **release**.")])
    let ask = await session.handle("approve")
    XCTAssertEqual(ask, "Approve Ship the release? Say yes to go ahead.")
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
    XCTAssertEqual(cancelled, "Okay, not approved. Ship it. Approve or deny it?")
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
    XCTAssertEqual(chose, "Choose Hall? Say yes to send it.")
    let choseSent = await session.handle("yes")
    XCTAssertEqual(choseSent, "Reply sent. Next: When? Say reply and your answer.")
    let replied = await session.handle("reply Friday at noon.")
    XCTAssertEqual(replied, "Reply Friday at noon? Say yes to send it.")
    let repliedSent = await session.handle("yeah")
    XCTAssertEqual(repliedSent, "Reply sent. That's everything.")
    let replies = await api.replies
    XCTAssertEqual(replies.map(\.decisionID), ["d1", "d2"])
    XCTAssertEqual(replies.map(\.text), ["Hall", "Friday at noon."])
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
    XCTAssertEqual(stale, "That one was already answered. Next: Pay the invoice. Approve or deny it?")
  }

  func testAReplyFailureIsSpoken() async {
    let (session, api, _) = await loaded([question("d1", "When?")])
    await api.failReplies(with: .invalid)
    _ = await session.handle("reply soon")
    let spoken = await session.handle("yes")
    XCTAssertEqual(spoken, BriefReplyFailure.invalid.message)
  }

  func testAReplyOrAChoiceIsNotSentWithoutAYes() async {
    let (session, api, _) = await loaded([question("d1", "Which venue?", options: ["Hall", "Garden"])])
    _ = await session.handle("answer let me think about the garden first")
    let other = await session.handle("what does the garden cost")
    XCTAssertNil(other)
    let chose = await session.handle("garden")
    XCTAssertEqual(chose, "Choose Garden? Say yes to send it.")
    let cancelled = await session.handle("no")
    XCTAssertEqual(cancelled, "Okay, not sent. Which venue? Options: Hall or Garden.")
    let replies = await api.replies
    XCTAssertTrue(replies.isEmpty)
  }

  func testNothingIsAnsweredWhileTheAppCannotAnswer() async {
    let (session, api, pending) = await loaded([approval("d1", "Ship it"), question("d2", "When?")])
    _ = await session.handle("approve")
    canAnswer = false
    let confirm = await session.handle("yes")
    XCTAssertEqual(confirm, BriefVoiceSession.lockedRefusal)
    let deny = await session.handle("deny")
    XCTAssertEqual(deny, BriefVoiceSession.lockedRefusal)
    let calls = await pending.calls
    XCTAssertTrue(calls.isEmpty)

    canAnswer = true
    _ = await session.handle("deny")
    _ = await session.handle("reply Friday")
    canAnswer = false
    let reply = await session.handle("yes")
    XCTAssertEqual(reply, BriefVoiceSession.lockedRefusal)
    let replies = await api.replies
    XCTAssertTrue(replies.isEmpty)
  }

  func testARefusedApprovalIsNotOfferedAgainButCanStillBeDenied() async {
    let (session, _, pending) = await loaded([approval("d1", "Ship it")])
    await pending.fail(with: .refused("Not allowed"))
    _ = await session.handle("approve")
    _ = await session.handle("yes")
    let again = await session.handle("approve")
    XCTAssertEqual(again, "That one can't be approved. Say deny to turn it down, or open the brief.")
    await pending.fail(with: nil)
    let denied = await session.handle("deny")
    XCTAssertEqual(denied, "Denied. That's everything.")
    let calls = await pending.calls
    XCTAssertEqual(calls, [.approve, .deny])
  }

  func testArchiveIsRefusedEvenWithNothingPendingAndOtherWordsGoToTheChat() async {
    let (session, _, _) = await loaded([approval("d1", "Ship it", .approved)])
    let archive = await session.handle("archive")
    XCTAssertEqual(archive, BriefVoiceSession.archiveRefusal)
    let approve = await session.handle("approve")
    XCTAssertNil(approve)
  }
}
