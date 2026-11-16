import UserNotifications
import XCTest

@testable import B4MKit

private let base = URL(string: "https://app.example.test")!
private func json(_ text: String) -> Data { Data(text.utf8) }
private let target = PendingActionTarget(questID: "quest-1", pendingActionTs: 1_767_225_600_000)

final class PendingActionClientTests: XCTestCase {
  private func client(_ transport: FakeTransport) -> PendingActionClient {
    PendingActionClient(baseURL: base, tokens: FakeTokens(), transport: transport)
  }

  func testApproveIsABearerPostWithTheShownTimestamp() async throws {
    let transport = FakeTransport { _ in (200, json(#"{"success":true,"message":"Issue created"}"#)) }

    let result = try await client(transport).respond(to: target, decision: .approve)

    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.url?.path(), "/api/v1/pending-actions/quest-1/approve")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-1")
    let sent = try JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: Int64]
    XCTAssertEqual(sent, ["pendingActionTs": 1_767_225_600_000])
    XCTAssertEqual(result, PendingActionResult(decision: .approve, toolSucceeded: true, message: "Issue created"))
  }

  func testDenyUsesTheDenyRoute() async throws {
    let transport = FakeTransport { _ in (200, json(#"{"success":true,"message":"Denied"}"#)) }
    _ = try await client(transport).respond(to: target, decision: .deny)
    let paths = await transport.requests.map { $0.url?.path() }
    XCTAssertEqual(paths, ["/api/v1/pending-actions/quest-1/deny"])
  }

  func testAToolFailureAfterApprovalIsNotAnError() async throws {
    let transport = FakeTransport { _ in (200, json(#"{"success":false,"message":"GitHub said no"}"#)) }
    let result = try await client(transport).respond(to: target, decision: .approve)
    XCTAssertFalse(result.toolSucceeded)
    XCTAssertEqual(result.message, "GitHub said no")
  }

  func testLifecycleConflictsMapToTheirOwnFailures() async {
    let cases: [(String, PendingActionFailure)] = [
      (#"{"error":"x","errorCode":"action_replaced"}"#, .replaced),
      (#"{"error":"x","errorCode":"action_expired"}"#, .expired),
      (#"{"error":"x","errorCode":"action_already_resolved"}"#, .alreadyResolved),
      (#"{"error":"x"}"#, .alreadyResolved),
    ]
    for (body, expected) in cases {
      let transport = FakeTransport { _ in (409, json(body)) }
      await assertFailure(client(transport), expected)
    }
  }

  func testAMissingOrForeignQuestIsNotFound() async {
    let transport = FakeTransport { _ in (404, json(#"{"error":"Not found"}"#)) }
    await assertFailure(client(transport), .notFound)
  }

  func testADeterministicRefusalCarriesTheServersReasonAndIsFinal() async {
    let reason = #"Repository "owner/repo" is not enabled. Available: other/repo"#
    let body = json(#"{"error":"Repository \"owner/repo\" is not enabled. Available: other/repo"}"#)
    await assertFailure(client(FakeTransport { _ in (400, body) }), .refused(reason))
    await assertFailure(client(FakeTransport { _ in (400, json("{}")) }), .refused(PendingActionFailure.unavailable.message))
    XCTAssertFalse(PendingActionFailure.refused(reason).isRetryable)
    XCTAssertEqual(PendingActionFailure.refused(reason).message, reason)
  }

  func testStatusesWithAPrecisePolicyStayOnTheAPIPath() async {
    await assertFailure(client(FakeTransport { _ in (429, json(#"{"error":"slow down"}"#)) }), .api(.rateLimited))
    await assertFailure(client(FakeTransport { _ in (403, json(#"{"error":"no"}"#)) }), .api(.forbidden))
  }

  func testOfflineAndServerErrorsAreRetryable() async {
    await assertFailure(client(FakeTransport { _ in throw URLError(.notConnectedToInternet) }), .api(.offline))
    await assertFailure(client(FakeTransport { _ in (503, Data()) }), .api(.server(status: 503)))
    XCTAssertTrue(PendingActionFailure.api(.offline).isRetryable)
    XCTAssertFalse(PendingActionFailure.expired.isRetryable)
    XCTAssertFalse(PendingActionFailure.alreadyResolved.isRetryable)
  }

  func testAMalformedQuestIdNeverReachesTheNetwork() async {
    let transport = FakeTransport { _ in (200, Data()) }
    let bad = PendingActionTarget(questID: "../admin", pendingActionTs: 1)
    do {
      _ = try await client(transport).respond(to: bad, decision: .approve)
      XCTFail("expected failure")
    } catch {
      XCTAssertEqual(error as? PendingActionFailure, .unavailable)
    }
    let requests = await transport.requests
    XCTAssertTrue(requests.isEmpty)
  }

  private func assertFailure(
    _ client: PendingActionClient, _ expected: PendingActionFailure, file: StaticString = #filePath,
    line: UInt = #line
  ) async {
    do {
      _ = try await client.respond(to: target, decision: .approve)
      XCTFail("expected failure", file: file, line: line)
    } catch {
      XCTAssertEqual(error as? PendingActionFailure, expected, file: file, line: line)
    }
  }
}

final class ApprovalPayloadTests: XCTestCase {
  func testParsesTheServersApprovalObject() {
    let payload = NotificationPayload(userInfo: [
      "aps": ["category": "approval_needed"], "questId": "quest-1", "sessionId": "s1",
      "approval": ["questId": "quest-1", "pendingActionTs": 1_767_225_600_000, "actions": ["approve", "deny"]],
    ])
    XCTAssertEqual(payload.category, .approvalNeeded)
    XCTAssertEqual(payload.approval, target)
  }

  func testMalformedApprovalIsDroppedNotGuessed() {
    for approval: Any in [
      ["questId": "quest-1"], ["pendingActionTs": 5], ["questId": "../x", "pendingActionTs": 5],
      ["questId": "quest-1", "pendingActionTs": "5"], ["questId": "quest-1", "pendingActionTs": -1], "nope",
    ] {
      XCTAssertNil(NotificationPayload(userInfo: ["approval": approval]).approval)
    }
  }

  func testCategoryOffersApproveBehindUnlockAndDenyWithout() throws {
    let category = ApprovalNotificationCategory.makeCategory()
    XCTAssertEqual(category.identifier, "approval_needed")
    let approve = try XCTUnwrap(category.actions.first { $0.identifier == "approve" })
    let deny = try XCTUnwrap(category.actions.first { $0.identifier == "deny" })
    XCTAssertTrue(approve.options.contains(.authenticationRequired))
    XCTAssertFalse(deny.options.contains(.authenticationRequired))
    XCTAssertEqual(category.actions.count, 2)
  }
}

@MainActor
private final class FeedbackRecorder: ApprovalFeedbackPosting {
  private(set) var posts: [(title: String, body: String)] = []
  func post(title: String, body: String) async { posts.append((title, body)) }
}

private actor ScriptedPendingActionAPI: PendingActionAPI {
  private(set) var calls: [(PendingActionTarget, PendingActionDecision)] = []
  private let outcome: Result<PendingActionResult, any Error>

  init(_ outcome: Result<PendingActionResult, any Error>) { self.outcome = outcome }

  func respond(to target: PendingActionTarget, decision: PendingActionDecision) async throws -> PendingActionResult {
    calls.append((target, decision))
    return try outcome.get()
  }
}

@MainActor
final class ApprovalNotificationHandlerTests: XCTestCase {
  private let payload = NotificationPayload(questID: "quest-1", category: .approvalNeeded, approval: target)

  private func handler(
    _ outcome: Result<PendingActionResult, any Error>
  ) -> (ApprovalNotificationHandler, ScriptedPendingActionAPI, FeedbackRecorder) {
    let api = ScriptedPendingActionAPI(outcome)
    let feedback = FeedbackRecorder()
    return (ApprovalNotificationHandler(api: api, feedback: feedback), api, feedback)
  }

  func testApproveButtonAnswersTheActionFromThePush() async {
    let (handler, api, feedback) = handler(.success(PendingActionResult(decision: .approve)))
    let handled = await handler.handle(actionIdentifier: "approve", payload: payload)
    XCTAssertTrue(handled)
    let calls = await api.calls
    XCTAssertEqual(calls.map(\.0), [target])
    XCTAssertEqual(calls.map(\.1), [.approve])
    XCTAssertEqual(feedback.posts.map(\.title), ["Approved"])
  }

  func testDenyButtonDenies() async {
    let (handler, api, feedback) = handler(.success(PendingActionResult(decision: .deny)))
    await handler.handle(actionIdentifier: "deny", payload: payload)
    let calls = await api.calls
    XCTAssertEqual(calls.map(\.1), [.deny])
    XCTAssertEqual(feedback.posts.map(\.title), ["Denied"])
  }

  func testAnExpiredApprovalFailsSafelyWithAClearMessage() async {
    let (handler, _, feedback) = handler(.failure(PendingActionFailure.expired))
    await handler.handle(actionIdentifier: "approve", payload: payload)
    XCTAssertEqual(feedback.posts.map(\.title), ["Couldn't approve"])
    XCTAssertEqual(feedback.posts.map(\.body), [PendingActionFailure.expired.message])
  }

  func testAReplayedAnswerIsReportedAsAlreadyAnswered() async {
    let (handler, _, feedback) = handler(.failure(PendingActionFailure.alreadyResolved))
    await handler.handle(actionIdentifier: "deny", payload: payload)
    XCTAssertEqual(feedback.posts.map(\.title), ["Couldn't deny"])
    XCTAssertEqual(feedback.posts.map(\.body), ["This request was already answered."])
  }

  func testANetworkFailureIsReportedNotSwallowed() async {
    let (handler, _, feedback) = handler(.failure(PendingActionFailure.api(.offline)))
    await handler.handle(actionIdentifier: "approve", payload: payload)
    XCTAssertEqual(feedback.posts.count, 1)
    XCTAssertTrue(feedback.posts[0].body.contains("offline"))
  }

  func testAToolFailureAfterApprovalSaysSo() async {
    let result = PendingActionResult(decision: .approve, toolSucceeded: false, message: "GitHub said no")
    let (handler, _, feedback) = handler(.success(result))
    await handler.handle(actionIdentifier: "approve", payload: payload)
    XCTAssertEqual(feedback.posts.map(\.body), ["GitHub said no"])
    XCTAssertNotEqual(feedback.posts.first?.title, "Approved")
  }

  func testAPushWithoutAnApprovalObjectNeverCallsTheServer() async {
    let (handler, api, feedback) = handler(.success(PendingActionResult(decision: .approve)))
    let bare = NotificationPayload(questID: "quest-1", category: .approvalNeeded)
    await handler.handle(actionIdentifier: "approve", payload: bare)
    let calls = await api.calls
    XCTAssertTrue(calls.isEmpty)
    XCTAssertEqual(feedback.posts.map(\.body), [PendingActionFailure.unavailable.message])
  }

  func testOtherActionsAreLeftToTheCaller() async {
    let (handler, api, feedback) = handler(.success(PendingActionResult(decision: .approve)))
    let handled = await handler.handle(actionIdentifier: UNNotificationDefaultActionIdentifier, payload: payload)
    XCTAssertFalse(handled)
    let calls = await api.calls
    XCTAssertTrue(calls.isEmpty)
    XCTAssertTrue(feedback.posts.isEmpty)
  }
}

@MainActor
final class ChatViewModelApprovalTests: XCTestCase {
  private let requestedAt = Samples.date
  private var action: PendingAction { PendingAction(tool: "create_issue", parameters: [:], requestedAt: requestedAt) }
  private var expected: PendingActionTarget {
    PendingActionTarget(questID: "quest-1", pendingActionTs: action.timestampMillis)
  }

  private func makeModel(_ outcome: Result<PendingActionResult, any Error>) -> (ChatViewModel, ScriptedPendingActionAPI)
  {
    let pending = ScriptedPendingActionAPI(outcome)
    let model = ChatViewModel(sessionID: "s1", api: FakeAPI(), realtime: nil, pendingActions: pending)
    return (model, pending)
  }

  func testTheTimestampRoundTripsToTheWireMilliseconds() {
    XCTAssertEqual(
      PendingAction(tool: "t", parameters: [:], requestedAt: Date(timeIntervalSince1970: 1_767_225_600.123))
        .timestampMillis, 1_767_225_600_123)
  }

  func testApprovingHidesTheButtonsAndRecordsTheAnswer() async {
    let (model, pending) = makeModel(.success(PendingActionResult(decision: .approve)))
    await model.respond(to: action, questID: "quest-1", decision: .approve)
    let state = model.approvalState(for: action, questID: "quest-1")
    XCTAssertEqual(state, .answered(PendingActionResult(decision: .approve)))
    XCTAssertFalse(state.offersDecision)
    let calls = await pending.calls
    XCTAssertEqual(calls.map(\.0), [expected])
  }

  func testAnExpiredAnswerIsFinalAndKeepsNoButtons() async {
    let (model, _) = makeModel(.failure(PendingActionFailure.expired))
    await model.respond(to: action, questID: "quest-1", decision: .approve)
    let state = model.approvalState(for: action, questID: "quest-1")
    XCTAssertEqual(state, .failed(.expired))
    XCTAssertFalse(state.offersDecision)
  }

  func testAnAlreadyResolvedAnswerIsFinal() async {
    let (model, _) = makeModel(.failure(PendingActionFailure.alreadyResolved))
    await model.respond(to: action, questID: "quest-1", decision: .deny)
    XCTAssertFalse(model.approvalState(for: action, questID: "quest-1").offersDecision)
  }

  func testANetworkFailureKeepsTheButtonsForARetry() async {
    let (model, pending) = makeModel(.failure(PendingActionFailure.api(.offline)))
    await model.respond(to: action, questID: "quest-1", decision: .approve)
    let state = model.approvalState(for: action, questID: "quest-1")
    XCTAssertEqual(state, .failed(.api(.offline)))
    XCTAssertTrue(state.offersDecision)

    await model.respond(to: action, questID: "quest-1", decision: .approve)
    let calls = await pending.calls
    XCTAssertEqual(calls.count, 2, "a retryable failure can be tried again")
  }

  func testASettledAnswerIsNotSentTwice() async {
    let (model, pending) = makeModel(.success(PendingActionResult(decision: .approve)))
    await model.respond(to: action, questID: "quest-1", decision: .approve)
    await model.respond(to: action, questID: "quest-1", decision: .deny)
    let calls = await pending.calls
    XCTAssertEqual(calls.count, 1)
  }

  func testAReplacementActionStartsOpen() async {
    let (model, _) = makeModel(.success(PendingActionResult(decision: .approve)))
    await model.respond(to: action, questID: "quest-1", decision: .approve)
    let newer = PendingAction(tool: "create_issue", parameters: [:], requestedAt: requestedAt.addingTimeInterval(60))
    XCTAssertEqual(model.approvalState(for: newer, questID: "quest-1"), .open)
  }

  func testWithoutTheServiceTheCardIsNotAnswerable() async {
    let model = ChatViewModel(sessionID: "s1", api: FakeAPI(), realtime: nil)
    XCTAssertFalse(model.canAnswerApprovals)
    await model.respond(to: action, questID: "quest-1", decision: .approve)
    XCTAssertEqual(model.approvalState(for: action, questID: "quest-1"), .open)
  }
}
