import UserNotifications
import XCTest

@testable import B4MKit

private actor StubBriefAPI: BriefAPI {
  private let fetched: Result<Brief, APIError>
  private let replyOutcome: Result<BriefReplyResult, BriefReplyFailure>
  private(set) var fetchedIDs: [String] = []
  private(set) var replies: [(briefID: String, decisionID: String, text: String)] = []

  init(
    _ fetched: Result<Brief, APIError>,
    reply: Result<BriefReplyResult, BriefReplyFailure> = .success(BriefReplyResult(executionID: "e1", sessionID: "s1"))
  ) {
    self.fetched = fetched
    self.replyOutcome = reply
  }

  func compose() async throws -> Brief { try fetched.get() }
  func list() async throws -> [Brief] { [] }

  func brief(id: String) async throws -> Brief {
    fetchedIDs.append(id)
    return try fetched.get()
  }

  func reply(briefID: String, decisionID: String, text: String, choiceIndex: Int?) async throws -> BriefReplyResult {
    replies.append((briefID, decisionID, text))
    return try replyOutcome.get()
  }
}

private actor StubPendingActionAPI: PendingActionAPI {
  private let outcome: Result<PendingActionResult, PendingActionFailure>
  private(set) var calls: [(PendingActionTarget, PendingActionDecision)] = []

  init(_ outcome: Result<PendingActionResult, PendingActionFailure>) { self.outcome = outcome }

  func respond(to target: PendingActionTarget, decision: PendingActionDecision) async throws -> PendingActionResult {
    calls.append((target, decision))
    return try outcome.get()
  }
}

@MainActor
private final class Feedback: ApprovalFeedbackPosting {
  private(set) var posts: [(title: String, body: String)] = []
  func post(title: String, body: String) async { posts.append((title, body)) }
}

private let payload = NotificationPayload(category: .briefReady, briefID: "b1")
private let approvalTarget = PendingActionTarget(questID: "q1", pendingActionTs: 1_700_000_000_000)

private func brief(_ decisions: [BriefDecision]) -> Brief {
  Brief(
    id: "b1", status: .ready, createdAt: Date(), periodStart: Date(), periodEnd: Date(), headline: "h",
    decisions: decisions)
}

private func approval(_ state: BriefApprovalState, id: String = "d1") -> BriefDecision {
  BriefDecision(
    id: id, text: "Approve it",
    approval: BriefApprovalRef(questID: "q1", sessionID: "s1", pendingActionTs: 1_700_000_000_000, state: state))
}

private func question(_ state: BriefQuestionState) -> BriefDecision {
  BriefDecision(
    id: "d1", text: "Which venue?",
    question: BriefQuestionRef(questID: "qq1", sessionID: "s1", options: ["Hall"], state: state))
}

@MainActor
final class BriefNotificationHandlerTests: XCTestCase {
  private func make(
    _ fetched: Result<Brief, APIError>,
    respond: Result<PendingActionResult, PendingActionFailure> = .success(PendingActionResult(decision: .approve)),
    reply: Result<BriefReplyResult, BriefReplyFailure> = .success(BriefReplyResult(executionID: "e1", sessionID: "s1"))
  ) -> (BriefNotificationHandler, StubBriefAPI, StubPendingActionAPI, Feedback) {
    let briefs = StubBriefAPI(fetched, reply: reply)
    let pending = StubPendingActionAPI(respond)
    let feedback = Feedback()
    return (
      BriefNotificationHandler(briefs: briefs, pendingActions: pending, feedback: feedback), briefs, pending, feedback
    )
  }

  func testRegistersTheServerSelectedCategoriesWithDistinctActionIdentifiers() {
    let categories = BriefNotificationCategory.makeCategories()
    XCTAssertEqual(
      categories.map(\.identifier), ["brief_ready_approval", "brief_ready_reply", "brief_ready_listen"])
    XCTAssertEqual(categories[0].actions.map(\.identifier), ["brief_approve", "brief_deny", "brief_listen"])
    XCTAssertTrue(categories[1].actions.first is UNTextInputNotificationAction)
    XCTAssertEqual(categories[1].actions.map(\.identifier), ["brief_reply", "brief_listen"])
    XCTAssertEqual(categories[2].actions.map(\.identifier), ["brief_listen"])
    XCTAssertTrue(categories.allSatisfy { $0.actions.last?.options.contains(.foreground) == true })
    XCTAssertNil(ApprovalNotificationCategory.decision(forActionIdentifier: "brief_approve"))
  }

  func testListenOpensVoiceForTheBriefWithoutFetchingIt() async {
    let (handler, briefs, pending, feedback) = make(.success(brief([approval(.pending)])))
    let outcome = await handler.handle(actionIdentifier: "brief_listen", replyText: nil, payload: payload)
    XCTAssertEqual(outcome, .listen(briefID: "b1"))
    let fetched = await briefs.fetchedIDs
    let calls = await pending.calls
    XCTAssertTrue(fetched.isEmpty)
    XCTAssertTrue(calls.isEmpty)
    XCTAssertTrue(feedback.posts.isEmpty)
  }

  func testListenWithoutABriefIDFallsBackToOpeningTheBrief() async {
    let (handler, briefs, _, feedback) = make(.success(brief([])))
    let outcome = await handler.handle(
      actionIdentifier: "brief_listen", replyText: nil, payload: NotificationPayload(category: .briefReady))
    XCTAssertEqual(outcome, .openBrief)
    let fetched = await briefs.fetchedIDs
    XCTAssertTrue(fetched.isEmpty)
    XCTAssertTrue(feedback.posts.isEmpty)
  }

  func testApproveRefetchesTheBriefAndAnswersItsPendingApproval() async {
    let (handler, briefs, pending, feedback) = make(.success(brief([approval(.pending)])))
    let outcome = await handler.handle(actionIdentifier: "brief_approve", replyText: nil, payload: payload)
    XCTAssertEqual(outcome, .handled)
    let fetched = await briefs.fetchedIDs
    XCTAssertEqual(fetched, ["b1"])
    let calls = await pending.calls
    XCTAssertEqual(calls.map(\.0), [approvalTarget])
    XCTAssertEqual(calls.map(\.1), [.approve])
    XCTAssertEqual(feedback.posts.map(\.title), ["Approved"])
  }

  func testDenyDenies() async {
    let (handler, _, pending, feedback) = make(
      .success(brief([approval(.pending)])), respond: .success(PendingActionResult(decision: .deny)))
    await handler.handle(actionIdentifier: "brief_deny", replyText: nil, payload: payload)
    let calls = await pending.calls
    XCTAssertEqual(calls.map(\.1), [.deny])
    XCTAssertEqual(feedback.posts.map(\.title), ["Denied"])
  }

  func testALapsedApprovalOnRefetchIsReportedAsStateWithoutCallingTheAPI() async {
    for (state, title) in [
      (BriefApprovalState.lapsed, "Approval lapsed"), (.replaced, "Approval replaced"),
      (.approved, "Already answered"),
    ] {
      let (handler, _, pending, feedback) = make(.success(brief([approval(state)])))
      let outcome = await handler.handle(actionIdentifier: "brief_approve", replyText: nil, payload: payload)
      XCTAssertEqual(outcome, .handled)
      let calls = await pending.calls
      XCTAssertTrue(calls.isEmpty, "\(state)")
      XCTAssertEqual(feedback.posts.map(\.title), [title])
    }
  }

  func testTwoDecisionsTakeNoActionAndOpenTheBrief() async {
    let (handler, briefs, pending, feedback) = make(
      .success(brief([approval(.pending), approval(.pending, id: "d2")])))
    let outcome = await handler.handle(actionIdentifier: "brief_approve", replyText: nil, payload: payload)
    XCTAssertEqual(outcome, .openBrief)
    let calls = await pending.calls
    let replies = await briefs.replies
    XCTAssertTrue(calls.isEmpty)
    XCTAssertTrue(replies.isEmpty)
    XCTAssertTrue(feedback.posts.isEmpty)
  }

  func testAnActionThatDoesNotMatchTheDecisionKindOpensTheBrief() async {
    let (handler, _, pending, _) = make(.success(brief([question(.open)])))
    let outcome = await handler.handle(actionIdentifier: "brief_approve", replyText: nil, payload: payload)
    XCTAssertEqual(outcome, .openBrief)
    let calls = await pending.calls
    XCTAssertTrue(calls.isEmpty)
  }

  func testReplyForwardsTheTypedTextToTheOpenQuestion() async {
    let (handler, briefs, _, feedback) = make(.success(brief([question(.open)])))
    let outcome = await handler.handle(actionIdentifier: "brief_reply", replyText: "  The hall  ", payload: payload)
    XCTAssertEqual(outcome, .handled)
    let replies = await briefs.replies
    XCTAssertEqual(replies.map(\.briefID), ["b1"])
    XCTAssertEqual(replies.map(\.decisionID), ["d1"])
    XCTAssertEqual(replies.map(\.text), ["The hall"])
    XCTAssertEqual(feedback.posts.map(\.title), ["Reply sent"])
  }

  func testReplyIsNotSentWhenEmptyOrTheQuestionIsNoLongerOpen() async {
    let cases: [(BriefQuestionState, String?, String)] = [
      (.open, "   ", BriefReplyFailure.invalid.message),
      (.answered, "Hi", BriefReplyFailure.closed.message),
      (.superseded, "Hi", BriefReplyFailure.notFound.message),
    ]
    for (state, text, body) in cases {
      let (handler, briefs, _, feedback) = make(.success(brief([question(state)])))
      await handler.handle(actionIdentifier: "brief_reply", replyText: text, payload: payload)
      let replies = await briefs.replies
      XCTAssertTrue(replies.isEmpty, "\(state)")
      XCTAssertEqual(feedback.posts.map(\.body), [body])
    }
  }

  func testAReplyConflictIsReported() async {
    let (handler, _, _, feedback) = make(.success(brief([question(.open)])), reply: .failure(.closed))
    await handler.handle(actionIdentifier: "brief_reply", replyText: "Hi", payload: payload)
    XCTAssertEqual(feedback.posts.map(\.body), [BriefReplyFailure.closed.message])
  }

  func testAFailedRefetchActsOnNothingAndOpensTheBrief() async {
    let (handler, _, pending, feedback) = make(.failure(.offline))
    let outcome = await handler.handle(actionIdentifier: "brief_approve", replyText: nil, payload: payload)
    XCTAssertEqual(outcome, .openBrief)
    let calls = await pending.calls
    XCTAssertTrue(calls.isEmpty)
    XCTAssertEqual(feedback.posts.map(\.body), [PendingActionFailure.api(.offline).message])
  }

  func testOtherActionsAreLeftToTheApprovalHandler() async {
    let (handler, briefs, _, _) = make(.success(brief([approval(.pending)])))
    let outcome = await handler.handle(actionIdentifier: "approve", replyText: nil, payload: payload)
    XCTAssertEqual(outcome, .notHandled)
    let fetched = await briefs.fetchedIDs
    XCTAssertTrue(fetched.isEmpty)
  }
}
