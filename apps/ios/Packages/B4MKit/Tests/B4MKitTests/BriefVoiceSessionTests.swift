import XCTest

@testable import B4MKit

private actor VoiceBriefAPI: BriefAPI {
  private var current: Result<Brief, APIError>
  private var replyFailure: BriefReplyFailure?
  private(set) var replies: [(decisionID: String, text: String, choiceIndex: Int?)] = []

  init(_ current: Result<Brief, APIError>) { self.current = current }

  func failReplies(with failure: BriefReplyFailure) { replyFailure = failure }
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
}
