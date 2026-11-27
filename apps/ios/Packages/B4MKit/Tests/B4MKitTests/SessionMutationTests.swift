import XCTest

@testable import B4MKit

@MainActor
final class SessionMutationTests: XCTestCase {
  private func makeModel(
    _ ids: [String] = ["a", "b", "c"], nextCursor: String? = nil
  ) async -> (SessionsViewModel, FakeAPI, InMemorySessionListCache, DeletedLog) {
    let api = FakeAPI()
    let sessions = ids.map { Samples.session($0) }
    await api.setSessions(sessions)
    await api.setSessionPages([nil: Page(items: sessions, nextCursor: nextCursor)])
    let cache = InMemorySessionListCache()
    let log = DeletedLog()
    let model = SessionsViewModel(
      api: api, cache: cache, onDeleted: { log.ids.append($0) }, onRenamed: { log.renames.append("\($0)=\($1)") })
    await model.refresh()
    return (model, api, cache, log)
  }

  private func waitForMutation(_ api: FakeAPI) async {
    while true {
      let (renames, deletes) = (await api.renames, await api.deletes)
      if !renames.isEmpty || !deletes.isEmpty { return }
      await Task.yield()
    }
  }

  func testRenameUpdatesTheListTheDrawerAndTheCache() async {
    let (model, api, cache, log) = await makeModel()

    await model.rename("b", to: "  Trip notes  ")

    let renames = await api.renames
    XCTAssertEqual(renames.map(\.name), ["Trip notes"])
    XCTAssertEqual(model.sessions.map(\.name), ["Session a", "Trip notes", "Session c"])
    XCTAssertEqual(model.drawerRecents.map(\.name), ["Session a", "Trip notes", "Session c"])
    let cached = await cache.load()
    XCTAssertEqual(cached?.map(\.name), ["Session a", "Trip notes", "Session c"])
    XCTAssertNil(model.mutationError)
    XCTAssertEqual(log.renames, ["b=Trip notes"])
  }

  func testFailedRenamePutsTheOldNameBack() async {
    let (model, api, cache, _) = await makeModel()
    await api.setRenameFailure(.offline)

    await model.rename("b", to: "Trip notes")

    XCTAssertEqual(model.sessions[1].name, "Session b")
    XCTAssertEqual(model.mutationError, .offline)
    let cached = await cache.load()
    XCTAssertEqual(cached?[1].name, "Session b")
  }

  func testBlankOrUnchangedNameMakesNoCall() async {
    let (model, api, _, _) = await makeModel()

    await model.rename("b", to: "   \n")
    await model.rename("b", to: "Session b")

    let renames = await api.renames
    XCTAssertTrue(renames.isEmpty)
    XCTAssertEqual(model.sessions[1].name, "Session b")
  }

  func testRenamingASessionTheServerNoLongerHasDropsTheRow() async {
    let (model, api, _, _) = await makeModel()
    await api.setRenameFailure(.notFound)

    await model.rename("b", to: "Trip notes")

    XCTAssertEqual(model.sessions.map(\.id), ["a", "c"])
    XCTAssertEqual(model.mutationError, .notFound)
  }

  func testDeleteRemovesTheRowEverywhere() async {
    let (model, api, cache, log) = await makeModel()

    await model.delete("b")

    let deletes = await api.deletes
    XCTAssertEqual(deletes, ["b"])
    XCTAssertEqual(model.sessions.map(\.id), ["a", "c"])
    XCTAssertEqual(model.drawerRecents.map(\.id), ["a", "c"])
    let cached = await cache.load()
    XCTAssertEqual(cached?.map(\.id), ["a", "c"])
    XCTAssertEqual(log.ids, ["b"])
  }

  func testDeletingAnAlreadyGoneSessionCountsAsDeleted() async {
    let (model, api, _, log) = await makeModel()
    await api.setDeleteFailure(.notFound)

    await model.delete("b")

    XCTAssertEqual(model.sessions.map(\.id), ["a", "c"])
    XCTAssertNil(model.mutationError)
    XCTAssertEqual(log.ids, ["b"])
  }

  func testRefusedDeletePutsTheRowBackWhereItWas() async {
    let (model, api, cache, log) = await makeModel()
    await api.setDeleteFailure(.conflict)

    await model.delete("b")

    XCTAssertEqual(model.sessions.map(\.id), ["a", "b", "c"])
    XCTAssertEqual(model.mutationError, .conflict)
    let cached = await cache.load()
    XCTAssertEqual(cached?.map(\.id), ["a", "b", "c"])
    XCTAssertTrue(log.ids.isEmpty)
  }

  func testLoadingMoreAfterADeleteDoesNotBringTheRowBack() async {
    let (model, api, _, _) = await makeModel(nextCursor: "c2")
    await api.setSessionPages([
      nil: Page(items: ["a", "b", "c"].map { Samples.session($0) }, nextCursor: "c2"),
      "c2": Page(items: [Samples.session("d")], nextCursor: nil),
    ])

    await model.delete("b")
    await model.loadMore()

    XCTAssertEqual(model.sessions.map(\.id), ["a", "c", "d"])
  }

  func testRenameSurvivesLoadingMore() async {
    let (model, api, _, _) = await makeModel(nextCursor: "c2")
    await api.setSessionPages([
      nil: Page(items: ["a", "b", "c"].map { Samples.session($0) }, nextCursor: "c2"),
      "c2": Page(items: [Samples.session("d")], nextCursor: nil),
    ])

    await model.rename("b", to: "Trip notes")
    await model.loadMore()

    XCTAssertEqual(model.sessions.map(\.name), ["Session a", "Trip notes", "Session c", "Session d"])
  }

  func testRollbackDoesNotClobberARefreshThatLandedMeanwhile() async {
    let (model, api, _, _) = await makeModel()
    await api.setRenameFailure(.offline)
    await api.holdMutations()

    let rename = Task { await model.rename("b", to: "Trip notes") }
    await waitForMutation(api)
    XCTAssertEqual(model.sessions[1].name, "Trip notes")
    let fromServer = SessionSummary(
      id: "b", name: "Renamed on the web", lastUsedModel: nil, firstCreated: Samples.date, lastUpdated: Samples.date)
    await api.setSessionPages([nil: Page(items: [Samples.session("a"), fromServer], nextCursor: nil)])
    await model.refresh()
    await api.releaseMutations()
    await rename.value

    XCTAssertEqual(model.sessions.map(\.name), ["Session a", "Renamed on the web"])
    XCTAssertEqual(model.mutationError, .offline)
  }

  func testASecondMutationOfARowInFlightIsIgnored() async {
    let (model, api, _, _) = await makeModel()
    await api.holdMutations()

    let first = Task { await model.rename("b", to: "First") }
    await waitForMutation(api)
    await model.rename("b", to: "Second")
    await model.delete("b")
    await api.releaseMutations()
    await first.value

    let renames = await api.renames
    let deletes = await api.deletes
    XCTAssertEqual(renames.map(\.name), ["First"])
    XCTAssertTrue(deletes.isEmpty)
    XCTAssertEqual(model.sessions[1].name, "First")
  }

  func testResetClearsRowsForTheNextAccount() async {
    let (model, _, _, _) = await makeModel()

    model.reset()

    XCTAssertTrue(model.sessions.isEmpty)
    XCTAssertTrue(model.drawerRecents.isEmpty)
    XCTAssertEqual(model.state, .idle)
    XCTAssertFalse(model.hasMore)
  }

  // Bounded, so a request the model wrongly skipped fails the assertions instead of hanging the suite.
  private func waitForSessionList(_ api: FakeAPI, count: Int) async {
    for _ in 0..<10_000 where await api.sessionCursors.count < count { await Task.yield() }
  }

  func testDeleteFailingAfterSignOutDoesNotBringTheOldAccountsRowBack() async {
    let (model, api, cache, log) = await makeModel()
    await api.setDeleteFailure(.conflict)
    await api.holdMutations()

    let delete = Task { await model.delete("b") }
    await waitForMutation(api)
    model.reset()
    await cache.clear()
    await api.releaseMutations()
    await delete.value

    XCTAssertTrue(model.sessions.isEmpty)
    XCTAssertNil(model.mutationError)
    XCTAssertTrue(log.ids.isEmpty)
    let cached = await cache.load()
    XCTAssertNil(cached)
  }

  func testRenameFailingAfterSignOutDoesNotWriteTheOldAccountsRows() async {
    let (model, api, cache, _) = await makeModel()
    await api.setRenameFailure(.offline)
    await api.holdMutations()

    let rename = Task { await model.rename("b", to: "Trip notes") }
    await waitForMutation(api)
    model.reset()
    await cache.clear()
    await api.releaseMutations()
    await rename.value

    XCTAssertTrue(model.sessions.isEmpty)
    XCTAssertNil(model.mutationError)
    let cached = await cache.load()
    XCTAssertNil(cached)
  }

  func testAMutationInFlightAtSignOutDoesNotBlockTheSameIDAfterwards() async {
    let (model, api, _, _) = await makeModel()
    await api.holdMutations()
    let stale = Task { await model.delete("b") }
    await waitForMutation(api)

    model.reset()
    await api.setSessionPages([nil: Page(items: [Samples.session("b")], nextCursor: nil)])
    await model.refresh()
    let rename = Task { await model.rename("b", to: "Next account") }
    for _ in 0..<10_000 where await api.renames.isEmpty { await Task.yield() }
    await api.releaseMutations()
    await stale.value
    await rename.value

    let renames = await api.renames
    XCTAssertEqual(renames.map(\.name), ["Next account"])
    XCTAssertEqual(model.sessions.map(\.name), ["Next account"])
  }

  func testRefreshInFlightAtSignOutDoesNotLeakRowsOrBlockTheNextRefresh() async {
    let (model, api, cache, _) = await makeModel()
    await api.holdSessionLists()

    let stale = Task { await model.refresh() }
    await waitForSessionList(api, count: 2)
    model.reset()
    await cache.clear()
    await api.releaseSessionLists()
    await stale.value

    XCTAssertTrue(model.sessions.isEmpty)
    XCTAssertEqual(model.state, .idle)
    let cached = await cache.load()
    XCTAssertNil(cached)

    await api.setSessionPages([nil: Page(items: [Samples.session("z")], nextCursor: nil)])
    await model.refresh()
    XCTAssertEqual(model.sessions.map(\.id), ["z"])
  }

  func testNextAccountsRefreshIsNotDroppedWhileTheOldOneIsStillInFlight() async {
    let (model, api, _, _) = await makeModel()
    await api.holdSessionLists()
    let stale = Task { await model.refresh() }
    await waitForSessionList(api, count: 2)

    model.reset()
    let next = Task { await model.refresh() }
    await waitForSessionList(api, count: 3)
    await api.setSessionPages([nil: Page(items: [Samples.session("z")], nextCursor: nil)])
    await api.releaseSessionLists()
    await stale.value
    await next.value

    XCTAssertEqual(model.sessions.map(\.id), ["z"])
    XCTAssertEqual(model.state, .loaded)
  }

  func testLoadMoreInFlightAtSignOutDoesNotAppendTheOldPage() async {
    let (model, api, _, _) = await makeModel(nextCursor: "p2")
    await api.setSessionPages([
      nil: Page(items: ["a", "b", "c"].map { Samples.session($0) }, nextCursor: "p2"),
      "p2": Page(items: [Samples.session("d")], nextCursor: nil),
    ])
    await api.holdSessionLists()
    let stale = Task { await model.loadMore() }
    await waitForSessionList(api, count: 2)

    model.reset()
    await api.releaseSessionLists()
    await stale.value

    XCTAssertTrue(model.sessions.isEmpty)
    XCTAssertFalse(model.isLoadingMore)
  }

  func testCancelledRefreshDoesNotReportAFailure() async {
    let api = FakeAPI()
    let model = SessionsViewModel(api: api, cache: InMemorySessionListCache())
    await api.holdSessionLists()
    // A cancelled URLSession request reaches the model as `.offline`.
    await api.setFailure(.offline)

    let refresh = Task { await model.refresh() }
    await waitForSessionList(api, count: 1)
    XCTAssertEqual(model.state, .loading)
    refresh.cancel()
    await api.releaseSessionLists()
    await refresh.value

    XCTAssertEqual(model.state, .idle)
  }

  func testCancelledLoadMoreDoesNotReportAFailure() async {
    let (model, api, _, _) = await makeModel(nextCursor: "p2")
    await api.holdSessionLists()
    await api.setFailure(.offline)

    let loadMore = Task { await model.loadMore() }
    await waitForSessionList(api, count: 2)
    loadMore.cancel()
    await api.releaseSessionLists()
    await loadMore.value

    XCTAssertNil(model.loadMoreError)
    XCTAssertEqual(model.state, .loaded)
  }
}

@MainActor
private final class DeletedLog {
  var ids: [String] = []
  var renames: [String] = []
}
