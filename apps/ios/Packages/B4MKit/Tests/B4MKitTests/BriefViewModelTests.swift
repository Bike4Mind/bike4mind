import XCTest

@testable import B4MKit

private actor FakeBriefAPI: BriefAPI {
  var composeResult: Result<Brief, APIError> = .success(makeBrief(status: .composing))
  var listResult: Result<[Brief], APIError> = .success([])
  /// Consumed one per `brief(id:)` call; the last repeats.
  var fetchResults: [Result<Brief, APIError>] = []
  private(set) var fetchCount = 0
  private(set) var composeCount = 0
  private var holdNextFetch = false
  private var fetchGate: CheckedContinuation<Void, Never>?
  private var fetchStarted: CheckedContinuation<Void, Never>?

  func holdFetch() { holdNextFetch = true }
  func waitForHeldFetch() async {
    if fetchGate != nil { return }
    await withCheckedContinuation { fetchStarted = $0 }
  }
  func releaseFetch() { fetchGate?.resume(); fetchGate = nil }

  func set(
    compose: Result<Brief, APIError>? = nil, list: Result<[Brief], APIError>? = nil,
    fetches: [Result<Brief, APIError>]? = nil
  ) {
    if let compose { composeResult = compose }
    if let list { listResult = list }
    if let fetches { fetchResults = fetches }
  }

  func compose() async throws -> Brief {
    composeCount += 1
    return try composeResult.get()
  }

  func list() async throws -> [Brief] { try listResult.get() }

  func brief(id: String) async throws -> Brief {
    defer { fetchCount += 1 }
    let index = min(fetchCount, max(fetchResults.count - 1, 0))
    let result = fetchResults[index]
    if holdNextFetch {
      holdNextFetch = false
      await withCheckedContinuation {
        fetchGate = $0
        fetchStarted?.resume()
        fetchStarted = nil
      }
    }
    return try result.get()
  }

  var replyResult: Result<BriefReplyResult, BriefReplyFailure> = .success(
    BriefReplyResult(executionID: "e1", sessionID: "s1"))
  private(set) var replies: [(briefID: String, decisionID: String, text: String, choiceIndex: Int?)] = []
  private var replyGate: CheckedContinuation<Void, Never>?
  private var replyStarted: CheckedContinuation<Void, Never>?
  private var holdNextReply = false

  func holdReply() { holdNextReply = true }
  func waitForHeldReply() async {
    if replyGate != nil { return }
    await withCheckedContinuation { replyStarted = $0 }
  }
  func releaseReply() { replyGate?.resume(); replyGate = nil }

  func setReply(_ result: Result<BriefReplyResult, BriefReplyFailure>) { replyResult = result }

  func reply(briefID: String, decisionID: String, text: String, choiceIndex: Int?) async throws -> BriefReplyResult {
    replies.append((briefID, decisionID, text, choiceIndex))
    if holdNextReply {
      holdNextReply = false
      await withCheckedContinuation {
        replyGate = $0
        replyStarted?.resume()
        replyStarted = nil
      }
    }
    return try replyResult.get()
  }
}

private actor FakePendingActionAPI: PendingActionAPI {
  var result: Result<PendingActionResult, PendingActionFailure> = .success(PendingActionResult(decision: .approve))
  private(set) var calls: [(PendingActionTarget, PendingActionDecision)] = []
  private var gate: CheckedContinuation<Void, Never>?
  private var holdNext = false
  private var started: CheckedContinuation<Void, Never>?

  func waitForHeldResponse() async {
    if gate != nil { return }
    await withCheckedContinuation { started = $0 }
  }

  func set(_ result: Result<PendingActionResult, PendingActionFailure>) { self.result = result }
  func hold() { holdNext = true }
  func release() { gate?.resume(); gate = nil }

  func respond(to target: PendingActionTarget, decision: PendingActionDecision) async throws -> PendingActionResult {
    calls.append((target, decision))
    if holdNext {
      holdNext = false
      await withCheckedContinuation {
        gate = $0
        started?.resume()
        started = nil
      }
    }
    return try result.get()
  }
}

private func briefWith(_ decision: BriefDecision, id: String = "b1") -> Brief {
  Brief(
    id: id, status: .ready, createdAt: Date(), periodStart: Date(), periodEnd: Date(), headline: "Headline",
    decisions: [decision])
}

private func approvalDecision(_ state: BriefApprovalState) -> BriefDecision {
  BriefDecision(
    id: "d1", text: "Approve it",
    approval: BriefApprovalRef(questID: "q1", sessionID: "s1", pendingActionTs: 1_700_000_000_000, state: state))
}

private func questionDecision(_ state: BriefQuestionState) -> BriefDecision {
  BriefDecision(
    id: "d2", text: "Which one?",
    question: BriefQuestionRef(questID: "q2", sessionID: "s2", options: ["A"], state: state))
}

private func makeBrief(id: String = "b1", status: BriefStatus) -> Brief {
  Brief(id: id, status: status, createdAt: Date(), periodStart: Date(), periodEnd: Date(), headline: "Headline")
}

private actor SleepRecorder {
  private(set) var count = 0
  func record() { count += 1 }
}

@MainActor
final class BriefViewModelTests: XCTestCase {
  private func model(
    _ api: FakeBriefAPI, id: String? = nil, recorder: SleepRecorder = SleepRecorder()
  ) -> BriefViewModel {
    BriefViewModel(api: api, briefID: id, sleep: { _ in await recorder.record() })
  }

  func testLoadByIdShowsThatBrief() async {
    let api = FakeBriefAPI()
    await api.set(fetches: [.success(makeBrief(status: .ready))])
    let model = model(api, id: "b1")
    await model.load()
    XCTAssertEqual(model.state, .loaded)
    XCTAssertEqual(model.brief?.id, "b1")
  }

  func testLoadWithoutIdShowsTheLatestReadyBrief() async {
    let api = FakeBriefAPI()
    await api.set(list: .success([makeBrief(id: "new", status: .failed), makeBrief(id: "old", status: .ready)]))
    let model = model(api)
    await model.load()
    XCTAssertEqual(model.brief?.id, "old")
  }

  func testLoadWithNoBriefsIsLoadedAndEmpty() async {
    let model = model(FakeBriefAPI())
    await model.load()
    XCTAssertEqual(model.state, .loaded)
    XCTAssertNil(model.brief)
  }

  func testLoadFailureSurfacesTheError() async {
    let api = FakeBriefAPI()
    await api.set(fetches: [.failure(.offline)])
    let model = model(api, id: "b1")
    await model.load()
    XCTAssertEqual(model.state, .failed(.offline))
    XCTAssertNil(model.brief)
  }

  func testComposePollsUntilReady() async {
    let api = FakeBriefAPI()
    await api.set(fetches: [.success(makeBrief(status: .composing)), .success(makeBrief(status: .ready))])
    let recorder = SleepRecorder()
    let model = model(api, recorder: recorder)
    await model.composeNow()
    XCTAssertEqual(model.brief?.status, .ready)
    XCTAssertFalse(model.isComposing)
    XCTAssertFalse(model.composeTimedOut)
    let sleeps = await recorder.count
    XCTAssertEqual(sleeps, 2)
  }

  func testComposePollsUntilFailed() async {
    let api = FakeBriefAPI()
    await api.set(fetches: [.success(makeBrief(status: .failed))])
    let model = model(api)
    await model.composeNow()
    XCTAssertEqual(model.brief?.status, .failed)
    XCTAssertFalse(model.isComposing)
  }

  func testComposeTimesOutAfterThePollWindow() async {
    let api = FakeBriefAPI()
    await api.set(fetches: [.success(makeBrief(status: .composing))])
    let recorder = SleepRecorder()
    let model = model(api, recorder: recorder)
    await model.composeNow()
    XCTAssertTrue(model.composeTimedOut)
    XCTAssertEqual(model.brief?.status, .composing)
    XCTAssertFalse(model.isComposing)
    let sleeps = await recorder.count
    XCTAssertEqual(sleeps, 15)
  }

  func testComposeRequestFailureIsReported() async {
    let api = FakeBriefAPI()
    await api.set(compose: .failure(.rateLimited))
    let model = model(api)
    await model.composeNow()
    XCTAssertEqual(model.state, .failed(.rateLimited))
    XCTAssertFalse(model.isComposing)
  }

  func testLoadingAComposingBriefResumesPolling() async {
    let api = FakeBriefAPI()
    await api.set(fetches: [.success(makeBrief(status: .composing)), .success(makeBrief(status: .ready))])
    let model = model(api, id: "b1")
    await model.load()
    XCTAssertEqual(model.brief?.status, .ready)
  }

  func testRefreshReloads() async {
    let api = FakeBriefAPI()
    await api.set(fetches: [.success(makeBrief(status: .ready))])
    let model = model(api, id: "b1")
    await model.load()
    await api.set(fetches: [
      .success(
        Brief(id: "b1", status: .ready, createdAt: Date(), periodStart: Date(), periodEnd: Date(), headline: "Updated"))
    ])
    await model.refresh()
    XCTAssertEqual(model.brief?.headline, "Updated")
  }

  func testAPollFailureWhileComposingKeepsTheBriefAndStopsComposing() async {
    let api = FakeBriefAPI()
    await api.set(fetches: [.failure(.offline)])
    let model = model(api)
    await model.composeNow()
    XCTAssertEqual(model.state, .failed(.offline))
    XCTAssertEqual(model.brief?.status, .composing)
    XCTAssertFalse(model.isComposing)
  }

  func testRefreshAfterATimeoutPollsAgainAndClearsTheTimeout() async {
    let api = FakeBriefAPI()
    await api.set(fetches: [.success(makeBrief(status: .composing))])
    let model = model(api, id: "b1")
    await model.load()
    XCTAssertTrue(model.composeTimedOut)
    await api.set(fetches: [.success(makeBrief(status: .ready))])
    await model.refresh()
    XCTAssertFalse(model.composeTimedOut)
    XCTAssertEqual(model.brief?.status, .ready)
  }

  func testCancellingAComposeStopsPolling() async {
    let api = FakeBriefAPI()
    await api.set(fetches: [.success(makeBrief(status: .composing))])
    let pollStarted = Locked(false)
    let model = BriefViewModel(
      api: api,
      sleep: { _ in
        pollStarted.mutate { $0 = true }
        try await Task.sleep(for: .seconds(3600))
      })
    defer { model.cancel() }
    model.startCompose()
    await eventually { pollStarted.current }
    XCTAssertTrue(model.isComposing)
    model.cancel()
    await eventually { await MainActor.run { !model.isComposing } }
    let composes = await api.composeCount
    XCTAssertEqual(composes, 1)
    XCTAssertFalse(model.isComposing)
    let fetches = await api.fetchCount
    XCTAssertEqual(fetches, 0)
  }

  func testAnUnknownStatusIsNotPolled() async {
    let api = FakeBriefAPI()
    await api.set(fetches: [.success(makeBrief(status: .unknown("archived")))])
    let recorder = SleepRecorder()
    let model = model(api, id: "b1", recorder: recorder)
    await model.load()
    XCTAssertEqual(model.brief?.status, .unknown("archived"))
    let sleeps = await recorder.count
    XCTAssertEqual(sleeps, 0)
  }

  func testARateLimitedPollWaitsAndKeepsPolling() async {
    let api = FakeBriefAPI()
    await api.set(fetches: [.failure(.rateLimited), .failure(.rateLimited), .success(makeBrief(status: .ready))])
    let model = model(api)
    await model.composeNow()
    XCTAssertEqual(model.brief?.status, .ready)
    XCTAssertEqual(model.state, .loaded)
  }
}

@MainActor
final class BriefViewModelDecisionTests: XCTestCase {
  private func loadedModel(
    _ api: FakeBriefAPI, pending: FakePendingActionAPI, fetches: [Result<Brief, APIError>]
  ) async -> BriefViewModel {
    await api.set(fetches: fetches)
    let model = BriefViewModel(api: api, briefID: "b1", pendingActions: pending, sleep: { _ in })
    await model.load()
    return model
  }

  func testApproveSucceedsThenRefetchesTheLiveState() async {
    let api = FakeBriefAPI()
    let pending = FakePendingActionAPI()
    let model = await loadedModel(
      api, pending: pending,
      fetches: [.success(briefWith(approvalDecision(.pending))), .success(briefWith(approvalDecision(.approved)))])
    await model.decide(approvalDecision(.pending), .approve)
    let calls = await pending.calls
    XCTAssertEqual(calls.count, 1)
    XCTAssertEqual(calls.first?.0, PendingActionTarget(questID: "q1", pendingActionTs: 1_700_000_000_000))
    XCTAssertEqual(calls.first?.1, .approve)
    let fetchCount = await api.fetchCount
    XCTAssertEqual(fetchCount, 2)
    XCTAssertEqual(model.brief?.decisions.first?.approval?.state, .approved)
  }

  func testExpiredRefetchesAndShowsLapsedInsteadOfAFailure() async {
    let api = FakeBriefAPI()
    let pending = FakePendingActionAPI()
    await pending.set(.failure(.expired))
    let model = await loadedModel(
      api, pending: pending,
      fetches: [.success(briefWith(approvalDecision(.pending))), .success(briefWith(approvalDecision(.lapsed)))])
    await model.decide(approvalDecision(.pending), .deny)
    XCTAssertNil(model.approvalStates["d1"])
    XCTAssertEqual(model.brief?.decisions.first?.approval?.state, .lapsed)
    XCTAssertEqual(model.state, .loaded)
  }

  func testRetryableFailureKeepsTheButtonsAndRefetches() async {
    let api = FakeBriefAPI()
    let pending = FakePendingActionAPI()
    await pending.set(.failure(.api(.offline)))
    let model = await loadedModel(api, pending: pending, fetches: [.success(briefWith(approvalDecision(.pending)))])
    await model.decide(approvalDecision(.pending), .approve)
    XCTAssertEqual(model.approvalStates["d1"], .failed(.api(.offline)))
    XCTAssertEqual(model.approvalStates["d1"]?.offersDecision, true)
    let fetchCount = await api.fetchCount
    XCTAssertEqual(fetchCount, 2)
  }

  func testRefusedApproveHidesApproveButStillOffersDeny() async {
    let api = FakeBriefAPI()
    let pending = FakePendingActionAPI()
    await pending.set(.failure(.refused("This action cannot be confirmed.")))
    let model = await loadedModel(
      api, pending: pending,
      fetches: [
        .success(briefWith(approvalDecision(.pending))), .success(briefWith(approvalDecision(.pending))),
        .success(briefWith(approvalDecision(.denied))),
      ])
    await model.decide(approvalDecision(.pending), .approve)
    XCTAssertEqual(model.approvalStates["d1"]?.offersDecision, false)
    XCTAssertEqual(model.approvalStates["d1"]?.offersDeny, true)
    await model.decide(approvalDecision(.pending), .approve)
    await pending.set(.success(PendingActionResult(decision: .deny)))
    await model.decide(approvalDecision(.pending), .deny)
    let calls = await pending.calls
    XCTAssertEqual(calls.map(\.1), [.approve, .deny])
    XCTAssertEqual(model.approvalStates["d1"], .answered(PendingActionResult(decision: .deny)))
    XCTAssertEqual(model.brief?.decisions.first?.approval?.state, .denied)
  }

  func testSecondTapWhileSubmittingIsIgnored() async {
    let api = FakeBriefAPI()
    let pending = FakePendingActionAPI()
    await pending.hold()
    let model = await loadedModel(api, pending: pending, fetches: [.success(briefWith(approvalDecision(.pending)))])
    let first = Task { await model.decide(approvalDecision(.pending), .approve) }
    while model.approvalStates["d1"]?.isSubmitting != true { await Task.yield() }
    await model.decide(approvalDecision(.pending), .approve)
    await pending.release()
    await first.value
    let calls = await pending.calls
    XCTAssertEqual(calls.count, 1)
  }

  func testANonPendingApprovalIsNeverSent() async {
    let api = FakeBriefAPI()
    let pending = FakePendingActionAPI()
    let model = await loadedModel(api, pending: pending, fetches: [.success(briefWith(approvalDecision(.replaced)))])
    await model.decide(approvalDecision(.replaced), .approve)
    let calls = await pending.calls
    XCTAssertTrue(calls.isEmpty)
  }

  func testReplySendsTrimmedTextAndRefetches() async {
    let api = FakeBriefAPI()
    let model = await loadedModel(
      api, pending: FakePendingActionAPI(),
      fetches: [.success(briefWith(questionDecision(.open))), .success(briefWith(questionDecision(.answered)))])
    await model.reply(questionDecision(.open), text: "  Go with A  ", choiceIndex: 0)
    let replies = await api.replies
    XCTAssertEqual(replies.count, 1)
    XCTAssertEqual(replies.first?.decisionID, "d2")
    XCTAssertEqual(replies.first?.text, "Go with A")
    XCTAssertEqual(replies.first?.choiceIndex, 0)
    XCTAssertEqual(model.replyStates["d2"], .sent)
    XCTAssertEqual(model.brief?.decisions.first?.question?.state, .answered)
  }

  func testClosedReplyRendersFromTheRefetchedState() async {
    let api = FakeBriefAPI()
    await api.setReply(.failure(.closed))
    let model = await loadedModel(
      api, pending: FakePendingActionAPI(),
      fetches: [.success(briefWith(questionDecision(.open))), .success(briefWith(questionDecision(.superseded)))])
    await model.reply(questionDecision(.open), text: "Hello")
    XCTAssertNil(model.replyStates["d2"])
    XCTAssertEqual(model.brief?.decisions.first?.question?.state, .superseded)
  }

  func testUnconfirmedDispatchNoticeSurvivesAnsweredRefetch() async throws {
    let api = FakeBriefAPI()
    let message = "Execution e1 dispatch could not be confirmed. Check it before starting another run."
    await api.setReply(.failure(.dispatchFailed(message)))
    let model = await loadedModel(
      api, pending: FakePendingActionAPI(),
      fetches: [.success(briefWith(questionDecision(.open))), .success(briefWith(questionDecision(.answered)))])
    await model.reply(questionDecision(.open), text: "Go")
    let current = try XCTUnwrap(model.brief?.decisions.first)
    XCTAssertEqual(current.question?.state, .answered)
    XCTAssertEqual(model.replyFailure(for: current)?.message, message)
  }

  func testBlankReplyIsNotSent() async {
    let api = FakeBriefAPI()
    let model = await loadedModel(
      api, pending: FakePendingActionAPI(), fetches: [.success(briefWith(questionDecision(.open)))])
    await model.reply(questionDecision(.open), text: "   ")
    let replies = await api.replies
    XCTAssertTrue(replies.isEmpty)
  }
}

@MainActor
final class BriefViewModelOwnershipTests: XCTestCase {
  func testCompletedReplyDoesNotSuppressReusedDecisionInNewBrief() async {
    let api = FakeBriefAPI()
    let decision = questionDecision(.open)
    await api.set(
      compose: .success(briefWith(decision, id: "b2")),
      list: .success([briefWith(decision)]), fetches: [.success(briefWith(decision))])
    let model = BriefViewModel(api: api, sleep: { _ in })
    await model.load()
    await model.reply(decision, text: "First")
    XCTAssertEqual(model.replyStates[decision.id], .sent)
    await model.composeNow()
    XCTAssertNil(model.replyStates[decision.id])
    await api.set(fetches: [.success(briefWith(decision, id: "b2"))])
    await model.reply(decision, text: "Second")
    let replies = await api.replies
    XCTAssertEqual(replies.map(\.briefID), ["b1", "b2"])
  }

  func testOldReplyCompletionDoesNotSettleOrReloadNewBrief() async {
    let api = FakeBriefAPI()
    let decision = questionDecision(.open)
    await api.set(
      compose: .success(briefWith(decision, id: "b2")), list: .success([briefWith(decision)]),
      fetches: [.success(briefWith(decision))])
    await api.holdReply()
    let model = BriefViewModel(api: api, sleep: { _ in })
    await model.load()
    model.setReplyDraft("First", decisionID: decision.id, briefID: "b1")
    let first = Task { await model.reply(decision, text: "First") }
    await api.waitForHeldReply()
    await model.composeNow()
    model.setReplyDraft("Second draft", decisionID: decision.id, briefID: "b2")
    model.setReplyDraft("Stale binding", decisionID: decision.id, briefID: "b1")
    await api.releaseReply()
    await first.value
    XCTAssertEqual(model.brief?.id, "b2")
    XCTAssertEqual(model.replyDrafts[decision.id], "Second draft")
    XCTAssertNil(model.replyStates[decision.id])
    let fetches = await api.fetchCount
    XCTAssertEqual(fetches, 0)
  }

  func testOldApprovalCompletionDoesNotSettleOrReloadNewBrief() async {
    let api = FakeBriefAPI()
    let pending = FakePendingActionAPI()
    let decision = approvalDecision(.pending)
    await api.set(
      compose: .success(briefWith(decision, id: "b2")), list: .success([briefWith(decision)]),
      fetches: [.success(briefWith(decision))])
    await pending.hold()
    let model = BriefViewModel(api: api, pendingActions: pending, sleep: { _ in })
    await model.load()
    let first = Task { await model.decide(decision, .approve) }
    await pending.waitForHeldResponse()
    await model.composeNow()
    await pending.release()
    await first.value
    XCTAssertEqual(model.brief?.id, "b2")
    XCTAssertNil(model.approvalStates[decision.id])
    let fetches = await api.fetchCount
    XCTAssertEqual(fetches, 0)
  }
  func testOldReloadResponseCannotReplaceNewBrief() async {
    let api = FakeBriefAPI()
    let decision = questionDecision(.open)
    await api.set(
      compose: .success(briefWith(decision, id: "b2")), list: .success([briefWith(decision)]),
      fetches: [.success(briefWith(questionDecision(.answered)))])
    let model = BriefViewModel(api: api, sleep: { _ in })
    await model.load()
    await api.holdFetch()
    let first = Task { await model.reply(decision, text: "First") }
    await api.waitForHeldFetch()
    await model.composeNow()
    model.setReplyDraft("Second draft", decisionID: decision.id, briefID: "b2")
    await api.releaseFetch()
    await first.value
    XCTAssertEqual(model.brief?.id, "b2")
    XCTAssertNil(model.replyStates[decision.id])
    XCTAssertEqual(model.replyDrafts[decision.id], "Second draft")
  }

  func testNewerDraftInSameBriefSurvivesReplyCompletion() async {
    let api = FakeBriefAPI()
    let decision = questionDecision(.open)
    await api.set(list: .success([briefWith(decision)]), fetches: [.success(briefWith(decision))])
    let model = BriefViewModel(api: api, sleep: { _ in })
    await model.load()
    await api.holdReply()
    model.setReplyDraft("First", decisionID: decision.id, briefID: "b1")
    let first = Task { await model.reply(decision, text: "First") }
    await api.waitForHeldReply()
    model.setReplyDraft("New draft", decisionID: decision.id, briefID: "b1")
    await api.releaseReply()
    await first.value
    XCTAssertEqual(model.replyDrafts[decision.id], "New draft")
  }

}
