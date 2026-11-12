import XCTest

@testable import B4MKit

final class PageAccumulatorTests: XCTestCase {
  func testAppendAccumulatesInOrderAndTracksTheCursor() {
    var pages = PageAccumulator<SessionSummary>()
    XCTAssertFalse(pages.hasLoadedFirstPage)

    pages.append(Page(items: [Samples.session("a"), Samples.session("b")], nextCursor: "c1"))
    XCTAssertTrue(pages.hasLoadedFirstPage)
    XCTAssertEqual(pages.nextCursor, "c1")

    pages.append(Page(items: [Samples.session("c")], nextCursor: nil))
    XCTAssertEqual(pages.items.map(\.id), ["a", "b", "c"])
    XCTAssertFalse(pages.hasMore)
  }

  func testRowsRepeatedAcrossPagesAppearOnce() {
    var pages = PageAccumulator<SessionSummary>()
    pages.append(Page(items: [Samples.session("a"), Samples.session("b")], nextCursor: "c1"))
    pages.append(Page(items: [Samples.session("b"), Samples.session("c")], nextCursor: nil))
    XCTAssertEqual(pages.items.map(\.id), ["a", "b", "c"])
  }

  func testReplaceStartsOver() {
    var pages = PageAccumulator<SessionSummary>()
    pages.append(Page(items: [Samples.session("a")], nextCursor: "c1"))
    pages.replace(with: Page(items: [Samples.session("z")], nextCursor: nil))
    XCTAssertEqual(pages.items.map(\.id), ["z"])
    XCTAssertNil(pages.nextCursor)
  }

  func testAnEmptyFirstPageStillCountsAsLoaded() {
    var pages = PageAccumulator<SessionSummary>()
    pages.append(Page(items: [], nextCursor: nil))
    XCTAssertTrue(pages.hasLoadedFirstPage)
    XCTAssertTrue(pages.items.isEmpty)
  }
}

@MainActor
final class SessionsViewModelTests: XCTestCase {
  func testRefreshThenLoadMoreWalksCursorsAndAccumulates() async {
    let api = FakeAPI()
    await api.setSessionPages([
      nil: Page(items: [Samples.session("a"), Samples.session("b")], nextCursor: "c2"),
      "c2": Page(items: [Samples.session("c")], nextCursor: nil),
    ])
    let model = SessionsViewModel(api: api, cache: InMemorySessionListCache(), pageSize: 2)

    await model.refresh()
    XCTAssertEqual(model.sessions.map(\.id), ["a", "b"])
    XCTAssertTrue(model.hasMore)

    await model.loadMore()
    XCTAssertEqual(model.sessions.map(\.id), ["a", "b", "c"])
    XCTAssertFalse(model.hasMore)
    let cursors = await api.sessionCursors
    XCTAssertEqual(cursors, [nil, "c2"])
  }

  func testPullToRefreshResetsToTheFirstPage() async {
    let api = FakeAPI()
    await api.setSessionPages([
      nil: Page(items: [Samples.session("a")], nextCursor: "c2"),
      "c2": Page(items: [Samples.session("b")], nextCursor: nil),
    ])
    let model = SessionsViewModel(api: api, cache: InMemorySessionListCache())
    await model.refresh()
    await model.loadMore()
    XCTAssertEqual(model.sessions.count, 2)

    await model.refresh()

    XCTAssertEqual(model.sessions.map(\.id), ["a"])
    XCTAssertTrue(model.hasMore)
  }

  func testSecondOpenRendersFromCacheBeforeTheNetworkAnswers() async {
    let cache = InMemorySessionListCache([Samples.session("cached")])
    let api = BlockingAPI()
    let model = SessionsViewModel(api: api, cache: cache)

    let loading = Task { await model.load() }
    await api.waitUntilRequested()

    XCTAssertEqual(model.sessions.map(\.id), ["cached"], "cached rows are on screen while the request is in flight")
    XCTAssertTrue(model.isShowingCachedRows)

    await api.release(Page(items: [Samples.session("fresh")], nextCursor: nil))
    await loading.value

    XCTAssertEqual(model.sessions.map(\.id), ["fresh"])
    XCTAssertFalse(model.isShowingCachedRows)
    let saved = await cache.load()
    XCTAssertEqual(saved?.map(\.id), ["fresh"], "the cache follows the server")
  }

  func testOfflineWithCacheKeepsRowsAndReportsTheError() async {
    let api = FakeAPI()
    await api.setFailure(.offline)
    let model = SessionsViewModel(api: api, cache: InMemorySessionListCache([Samples.session("cached")]))

    await model.load()

    XCTAssertEqual(model.sessions.map(\.id), ["cached"])
    XCTAssertEqual(model.state, .failed(.offline))
  }

  func testEmptyAccountLoadsAsEmptyNotFailed() async {
    let api = FakeAPI()
    await api.setSessionPages([nil: Page(items: [], nextCursor: nil)])
    let model = SessionsViewModel(api: api, cache: InMemorySessionListCache())
    await model.refresh()
    XCTAssertEqual(model.state, .loaded)
    XCTAssertTrue(model.sessions.isEmpty)
  }
}

/// A `B4MAPI` whose first `listSessions` call waits until the test releases it.
private actor BlockingAPI: B4MAPI {
  private var continuation: CheckedContinuation<Page<SessionSummary>, Never>?
  private var requested = false
  private var requestWaiters: [CheckedContinuation<Void, Never>] = []

  func waitUntilRequested() async {
    if requested { return }
    await withCheckedContinuation { requestWaiters.append($0) }
  }

  func release(_ page: Page<SessionSummary>) {
    continuation?.resume(returning: page)
    continuation = nil
  }

  func listSessions(cursor: String?, limit: Int) async throws -> Page<SessionSummary> {
    requested = true
    requestWaiters.forEach { $0.resume() }
    requestWaiters = []
    return await withCheckedContinuation { continuation = $0 }
  }

  func listSessionQuests(sessionID: String, cursor: String?, limit: Int) async throws -> Page<QuestTurn> {
    Page(items: [], nextCursor: nil)
  }

  func sendChatMessage(_ request: ChatSendRequest) async throws -> ChatSendReceipt { throw APIError.notFound }
  func quest(id: String) async throws -> QuestTurn { throw APIError.notFound }

  func creditBalance() async throws -> CreditBalance { CreditBalance(credits: 0) }
}
