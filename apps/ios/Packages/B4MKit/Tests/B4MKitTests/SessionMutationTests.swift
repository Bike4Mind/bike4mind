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
    let model = SessionsViewModel(api: api, cache: cache, onDeleted: { log.ids.append($0) })
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
    let (model, api, cache, _) = await makeModel()

    await model.rename("b", to: "  Trip notes  ")

    let renames = await api.renames
    XCTAssertEqual(renames.map(\.name), ["Trip notes"])
    XCTAssertEqual(model.sessions.map(\.name), ["Session a", "Trip notes", "Session c"])
    XCTAssertEqual(model.drawerRecents.map(\.name), ["Session a", "Trip notes", "Session c"])
    let cached = await cache.load()
    XCTAssertEqual(cached?.map(\.name), ["Session a", "Trip notes", "Session c"])
    XCTAssertNil(model.mutationError)
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
}

@MainActor
private final class DeletedLog {
  var ids: [String] = []
}
