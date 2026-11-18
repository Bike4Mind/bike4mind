import XCTest

@testable import B4MKit

private actor FakeBriefAPI: BriefAPI {
  var composeResult: Result<Brief, APIError> = .success(makeBrief(status: .composing))
  var listResult: Result<[Brief], APIError> = .success([])
  /// Consumed one per `brief(id:)` call; the last repeats.
  var fetchResults: [Result<Brief, APIError>] = []
  private(set) var fetchCount = 0
  private(set) var composeCount = 0

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
    return try fetchResults[index].get()
  }
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
    XCTAssertEqual(sleeps, 45)
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
    let model = BriefViewModel(
      api: api, sleep: { _ in try Task.checkCancellation() })
    model.startCompose()
    model.cancel()
    for _ in 0..<50 { await Task.yield() }
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
}
