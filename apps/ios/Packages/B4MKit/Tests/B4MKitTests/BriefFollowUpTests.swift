import XCTest

@testable import B4MKit

final class BriefFollowUpClientTests: XCTestCase {
  private let base = URL(string: "https://app.example.test")!

  static let followUpJSON = """
    {"id":"b2","status":"ready","createdAt":"2026-11-17T01:00:00.123Z",
     "periodStart":"2026-11-17T01:00:00.000Z","periodEnd":"2026-11-17T01:00:00.000Z","headline":"Follow-ups",
     "happened":[],"handled":[],
     "decisions":[
       {"id":"fu-action-1","text":"Book the venue","followUp":{"kind":"actionItem","state":"pending","remindAt":null}},
       {"id":"fu-email","text":"Send follow-up to Sam: Notes","followUp":{"kind":"followUpEmail","state":"pending"},
        "draftReply":{"to":"Sam","subject":"Notes","body":"Here are the notes."}},
       {"id":"fu-reminder-1","text":"Remind me: call back",
        "followUp":{"kind":"reminder","state":"approved","remindAt":"2026-11-18T09:00:00.000Z"}},
       {"id":"fu-x","text":"Something new","followUp":{"kind":"calendarHold","state":"snoozed","remindAt":null}},
       {"id":"d1","text":"Legacy decision"}]}
    """

  private func client(_ status: Int, _ body: String) -> (BriefClient, FakeTransport) {
    let transport = FakeTransport { _ in (status, Data(body.utf8)) }
    return (BriefClient(baseURL: base, tokens: FakeTokens(), transport: transport), transport)
  }

  private func sentBody(_ transport: FakeTransport) async throws -> [String: Any] {
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    let body = try XCTUnwrap(request.httpBody)
    return try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
  }

  func testFollowUpDecisionsDecodeIncludingUnknownAndLegacy() async throws {
    let (client, _) = client(200, Self.followUpJSON)
    let decisions = try await client.brief(id: "b2").decisions
    XCTAssertEqual(decisions[0].followUp, BriefFollowUpRef(kind: .actionItem, state: .pending))
    XCTAssertTrue(decisions[0].followUp?.isActionable == true)
    XCTAssertEqual(decisions[1].draftReply, BriefDraftReply(to: "Sam", subject: "Notes", body: "Here are the notes."))
    XCTAssertEqual(decisions[2].followUp?.state, .approved)
    XCTAssertEqual(decisions[2].followUp?.remindAt, Date(timeIntervalSince1970: 1_794_992_400))
    XCTAssertFalse(decisions[2].followUp?.isActionable == true)
    XCTAssertEqual(decisions[3].followUp?.kind, .unknown("calendarHold"))
    XCTAssertEqual(decisions[3].followUp?.state, .unknown("snoozed"))
    XCTAssertFalse(decisions[3].followUp?.isActionable == true)
    XCTAssertNil(decisions[4].followUp)
    XCTAssertNil(decisions[4].draftReply)
  }

  func testFollowUpPostsTranscriptAndZone() async throws {
    let (client, transport) = client(202, BriefClientTests.readyJSON)
    let brief = try await client.followUp(transcript: "Email Sam the notes", timeZone: "Europe/Paris")
    XCTAssertEqual(brief.id, "b1")
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.url?.path(), "/api/v1/briefs/follow-ups")
    let sent = try await sentBody(transport)
    XCTAssertEqual(sent["transcript"] as? String, "Email Sam the notes")
    XCTAssertEqual(sent["timeZone"] as? String, "Europe/Paris")
  }

  func testEditPatchesOnlyTheGivenFields() async throws {
    let decision = """
      {"id":"fu-reminder-1","text":"Call",
       "followUp":{"kind":"reminder","state":"pending","remindAt":"2026-11-18T09:00:00Z"}}
      """
    let (client, transport) = client(200, decision)
    let updated = try await client.editDecision(
      briefID: "b2", decisionID: "fu-reminder-1",
      edit: BriefDecisionEdit(remindAt: Date(timeIntervalSince1970: 1_794_992_400)))
    XCTAssertEqual(updated.followUp?.kind, .reminder)
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "PATCH")
    XCTAssertEqual(request.url?.path(), "/api/v1/briefs/b2/decisions/fu-reminder-1")
    let sent = try await sentBody(transport)
    XCTAssertEqual(sent["remindAt"] as? String, "2026-11-18T09:00:00Z")
    XCTAssertEqual(sent.count, 1)
  }

  func testResolvePostsTheOutcome() async throws {
    let decision = #"{"id":"fu-action-1","text":"Book","followUp":{"kind":"actionItem","state":"dismissed"}}"#
    let (client, transport) = client(200, decision)
    let updated = try await client.resolveDecision(briefID: "b2", decisionID: "fu-action-1", outcome: .dismiss)
    XCTAssertEqual(updated.followUp?.state, .dismissed)
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.url?.path(), "/api/v1/briefs/b2/decisions/fu-action-1/resolve")
    let sent = try await sentBody(transport)
    XCTAssertEqual(sent["outcome"] as? String, "dismiss")
  }

  func testDecisionStatusesMapToTypedFailures() async {
    let cases: [(Int, String, BriefDecisionFailure)] = [
      (409, #"{"error":"Already settled","errorCode":"decision_closed"}"#, .closed),
      (404, "{}", .notFound),
      (
        400, #"{"error":"Edit the recipient to an email address first"}"#,
        .invalid("Edit the recipient to an email address first")
      ),
      (400, "{}", .invalid(BriefClient.fallbackInvalidDecision)),
      (409, #"{"error":"Busy"}"#, .api(.server(status: 409))),
      (429, "{}", .api(.rateLimited)),
    ]
    for (status, body, expected) in cases {
      let (client, _) = client(status, body)
      do {
        _ = try await client.resolveDecision(briefID: "b2", decisionID: "fu-email", outcome: .approve)
        XCTFail("expected \(expected) for \(status)")
      } catch let failure as BriefDecisionFailure {
        XCTAssertEqual(failure, expected, "status \(status)")
      } catch {
        XCTFail("unexpected \(error)")
      }
    }
  }

  func testMailtoEscapesReservedCharacters() throws {
    let draft = BriefDraftReply(to: " sam@example.com ", subject: "Q&A + notes", body: "a=b?\nthanks")
    let url = try XCTUnwrap(draft.mailtoURL)
    XCTAssertEqual(
      url.absoluteString, "mailto:sam@example.com?subject=Q%26A%20%2B%20notes&body=a%3Db%3F%0Athanks")
  }

  func testUntouchedPaddedFormIsNotAnEdit() {
    let decision = emailDecision(.pending)
    let edit = BriefDecisionEdit(
      changing: decision, kind: .followUpEmail, text: " \(decision.text) ",
      draft: BriefDraftReply(to: " sam@example.com", subject: "Notes ", body: "Here they are."),
      remindAt: Date(timeIntervalSince1970: 0), initialRemindAt: Date(timeIntervalSince1970: 0))
    XCTAssertTrue(edit.isEmpty)
  }

  func testChangedRecipientSendsTheWholeTrimmedDraft() {
    let decision = emailDecision(.pending)
    let edit = BriefDecisionEdit(
      changing: decision, kind: .followUpEmail, text: decision.text,
      draft: BriefDraftReply(to: " alex@example.com ", subject: "Notes", body: "Here they are."),
      remindAt: Date(timeIntervalSince1970: 0), initialRemindAt: Date(timeIntervalSince1970: 0))
    XCTAssertEqual(
      edit,
      BriefDecisionEdit(draftReply: BriefDraftReply(to: "alex@example.com", subject: "Notes", body: "Here they are.")))
  }

  func testReminderTimeIsSentOnlyForAReminderThatChanged() {
    let decision = emailDecision(.pending)
    let start = Date(timeIntervalSince1970: 0)
    let later = start.addingTimeInterval(3600)
    func edit(_ kind: BriefFollowUpKind, _ remindAt: Date) -> BriefDecisionEdit {
      BriefDecisionEdit(
        changing: decision, kind: kind, text: decision.text, draft: draft, remindAt: remindAt, initialRemindAt: start)
    }
    XCTAssertEqual(edit(.reminder, later).remindAt, later)
    XCTAssertNil(edit(.reminder, start).remindAt)
    XCTAssertNil(edit(.actionItem, later).remindAt)
  }
}

private actor FakeFollowUpAPI: BriefFollowUpAPI {
  var resolveResult: Result<BriefDecision, BriefDecisionFailure>
  var editResult: Result<BriefDecision, BriefDecisionFailure>
  private(set) var resolveCalls: [BriefDecisionOutcome] = []
  private(set) var editCalls: [BriefDecisionEdit] = []
  private var gate: CheckedContinuation<Void, Never>?
  private var started: CheckedContinuation<Void, Never>?
  private var holdNext = false

  init(resolve: Result<BriefDecision, BriefDecisionFailure>, edit: Result<BriefDecision, BriefDecisionFailure>) {
    resolveResult = resolve
    editResult = edit
  }

  func hold() { holdNext = true }
  func waitForHeld() async {
    if gate != nil { return }
    await withCheckedContinuation { started = $0 }
  }
  func release() { gate?.resume(); gate = nil }

  func followUp(transcript: String, timeZone: String?) async throws -> Brief { throw APIError.notFound }

  func editDecision(briefID: String, decisionID: String, edit: BriefDecisionEdit) async throws -> BriefDecision {
    editCalls.append(edit)
    return try editResult.get()
  }

  func resolveDecision(
    briefID: String, decisionID: String, outcome: BriefDecisionOutcome
  ) async throws -> BriefDecision {
    resolveCalls.append(outcome)
    if holdNext {
      holdNext = false
      await withCheckedContinuation {
        gate = $0
        started?.resume()
        started = nil
      }
    }
    return try resolveResult.get()
  }
}

private actor StaticBriefAPI: BriefAPI {
  var current: Brief
  private(set) var fetchCount = 0
  init(_ brief: Brief) { current = brief }
  func set(_ brief: Brief) { current = brief }
  func compose() async throws -> Brief { current }
  func list() async throws -> [Brief] { [current] }
  func brief(id: String) async throws -> Brief {
    fetchCount += 1
    return current
  }
  func reply(briefID: String, decisionID: String, text: String, choiceIndex: Int?) async throws -> BriefReplyResult {
    throw BriefReplyFailure.notFound
  }
}

private let draft = BriefDraftReply(to: "sam@example.com", subject: "Notes", body: "Here they are.")

private func emailDecision(_ state: BriefFollowUpState) -> BriefDecision {
  BriefDecision(
    id: "fu-email", text: "Send follow-up to Sam: Notes",
    followUp: BriefFollowUpRef(kind: .followUpEmail, state: state), draftReply: draft)
}

private func briefWith(_ decisions: [BriefDecision]) -> Brief {
  Brief(
    id: "b2", status: .ready, createdAt: Date(), periodStart: Date(), periodEnd: Date(), headline: "Follow-ups",
    decisions: decisions)
}

@MainActor
final class BriefFollowUpViewModelTests: XCTestCase {
  private func loaded(
    _ decisions: [BriefDecision], followUps: FakeFollowUpAPI
  ) async -> (BriefViewModel, StaticBriefAPI) {
    let api = StaticBriefAPI(briefWith(decisions))
    let model = BriefViewModel(api: api, briefID: "b2", followUps: followUps, sleep: { _ in })
    await model.load()
    return (model, api)
  }

  func testApprovingAnEmailSwapsTheDecisionAndReturnsTheDraft() async {
    let followUps = FakeFollowUpAPI(resolve: .success(emailDecision(.approved)), edit: .failure(.notFound))
    let other = BriefDecision(id: "d1", text: "Other")
    let (model, _) = await loaded([emailDecision(.pending), other], followUps: followUps)
    let handed = await model.resolveFollowUp(emailDecision(.pending), .approve)
    XCTAssertEqual(handed, draft)
    XCTAssertEqual(model.brief?.decisions.map(\.followUp?.state), [.approved, nil])
    XCTAssertNil(model.followUpStates["fu-email"])
  }

  func testDismissReturnsNoDraft() async {
    let followUps = FakeFollowUpAPI(resolve: .success(emailDecision(.dismissed)), edit: .failure(.notFound))
    let (model, _) = await loaded([emailDecision(.pending)], followUps: followUps)
    let handed = await model.resolveFollowUp(emailDecision(.pending), .dismiss)
    XCTAssertNil(handed)
    XCTAssertEqual(model.brief?.decisions.first?.followUp?.state, .dismissed)
    let calls = await followUps.resolveCalls
    XCTAssertEqual(calls, [.dismiss])
  }

  func testADoubleTapSendsOneRequest() async {
    let followUps = FakeFollowUpAPI(resolve: .success(emailDecision(.approved)), edit: .failure(.notFound))
    let (model, _) = await loaded([emailDecision(.pending)], followUps: followUps)
    await followUps.hold()
    let first = Task { await model.resolveFollowUp(emailDecision(.pending), .approve) }
    await followUps.waitForHeld()
    XCTAssertEqual(model.followUpStates["fu-email"], .submitting)
    let second = await model.resolveFollowUp(emailDecision(.pending), .approve)
    XCTAssertNil(second)
    await followUps.release()
    _ = await first.value
    let calls = await followUps.resolveCalls
    XCTAssertEqual(calls, [.approve])
  }

  func testAClosedDecisionRefetchesInsteadOfShowingAnError() async {
    let followUps = FakeFollowUpAPI(resolve: .failure(.closed), edit: .failure(.notFound))
    let (model, api) = await loaded([emailDecision(.pending)], followUps: followUps)
    await api.set(briefWith([emailDecision(.approved)]))
    let handed = await model.resolveFollowUp(emailDecision(.pending), .approve)
    XCTAssertNil(handed)
    XCTAssertNil(model.followUpStates["fu-email"])
    XCTAssertEqual(model.brief?.decisions.first?.followUp?.state, .approved)
  }

  func testAnEditOfADecisionSettledElsewhereClosesTheForm() async {
    let followUps = FakeFollowUpAPI(resolve: .failure(.notFound), edit: .failure(.closed))
    let (model, api) = await loaded([emailDecision(.pending)], followUps: followUps)
    await api.set(briefWith([emailDecision(.approved)]))
    let done = await model.editFollowUp(emailDecision(.pending), BriefDecisionEdit(text: "New text"))
    XCTAssertTrue(done)
    XCTAssertNil(model.followUpStates["fu-email"])
    XCTAssertEqual(model.brief?.decisions.first?.followUp?.state, .approved)
  }

  func testAFailedEditKeepsTheDecisionAndReportsWhy() async {
    let followUps = FakeFollowUpAPI(
      resolve: .failure(.notFound), edit: .failure(.invalid("Edit the recipient to an email address first")))
    let (model, _) = await loaded([emailDecision(.pending)], followUps: followUps)
    let saved = await model.editFollowUp(emailDecision(.pending), BriefDecisionEdit(text: "New text"))
    XCTAssertFalse(saved)
    XCTAssertEqual(model.brief?.decisions.first, emailDecision(.pending))
    XCTAssertEqual(
      model.followUpFailure(for: emailDecision(.pending)), .invalid("Edit the recipient to an email address first"))
  }

  func testSettledOrUnknownFollowUpsAreNotSent() async {
    let unknown = BriefDecision(
      id: "fu-x", text: "New kind", followUp: BriefFollowUpRef(kind: .unknown("calendarHold"), state: .pending))
    let followUps = FakeFollowUpAPI(resolve: .success(emailDecision(.approved)), edit: .failure(.notFound))
    let (model, _) = await loaded([emailDecision(.approved), unknown], followUps: followUps)
    _ = await model.resolveFollowUp(emailDecision(.approved), .dismiss)
    _ = await model.resolveFollowUp(unknown, .approve)
    let saved = await model.editFollowUp(unknown, BriefDecisionEdit())
    XCTAssertFalse(saved)
    let calls = await followUps.resolveCalls
    XCTAssertEqual(calls, [])
  }
}
