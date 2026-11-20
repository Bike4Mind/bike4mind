import XCTest

@testable import B4MKit

@MainActor
final class SettledTranscriptCacheTests: XCTestCase {
  func testReopenRendersImmediatelyWithoutPageOneAndRefreshDiscoversNewTurn() async {
    let api = FakeAPI()
    let cache = SettledTranscriptCache()
    await api.setQuestPages([nil: Page(items: [Samples.quest("1")], nextCursor: nil)])
    let first = ChatViewModel(sessionID: "s", api: api, realtime: nil, transcriptCache: cache)
    await first.load()
    first.stop()

    let reopened = ChatViewModel(sessionID: "s", api: api, realtime: nil, transcriptCache: cache)
    XCTAssertEqual(reopened.turns.map(\.id), ["1"])
    await reopened.load()
    let beforeRefresh = await api.questCursors
    XCTAssertEqual(beforeRefresh.count, 1)

    await api.setQuestPages([
      nil: Page(items: [Samples.quest("1"), Samples.quest("2")], nextCursor: nil)
    ])
    await reopened.refresh()
    XCTAssertEqual(reopened.turns.map(\.id), ["1", "2"])
    let afterRefresh = await api.questCursors
    XCTAssertEqual(afterRefresh.count, 2)
    reopened.stop()
  }

  func testUnsettledTailIsExcludedAndRevalidatedWithoutRefetchingSettledPages() async {
    let api = FakeAPI()
    let cache = SettledTranscriptCache()
    await api.setQuestPages([
      nil: Page(items: [Samples.quest("1", status: nil)], nextCursor: "tail"),
      "tail": Page(items: [Samples.quest("2"), Samples.quest("3", status: .running)], nextCursor: nil),
    ])
    let first = TranscriptViewModel(sessionID: "s", api: api, pageSize: 2, cache: cache)
    await first.load()
    await first.loadMore()

    let reopened = TranscriptViewModel(sessionID: "s", api: api, pageSize: 2, cache: cache)
    XCTAssertEqual(reopened.turns.map(\.id), ["1", "2"])
    await api.setQuestPages([
      "tail": Page(items: [Samples.quest("2"), Samples.quest("3", reply: "finished")], nextCursor: nil)
    ])
    await reopened.load()
    XCTAssertEqual(reopened.turns.map(\.id), ["1", "2", "3"])
    XCTAssertEqual(reopened.turns.last?.reply, "finished")
    let cursors = await api.questCursors
    XCTAssertEqual(cursors, [nil, "tail", "tail"])
  }

  func testLiveOpeningTurnIsNeverCachedOrReplacedByHistory() async {
    let api = FakeAPI()
    let cache = SettledTranscriptCache()
    await api.setQuestPages([nil: Page(items: [Samples.quest("1")], nextCursor: nil)])
    await TranscriptViewModel(sessionID: "s", api: api, cache: cache).load()
    let live = Samples.quest("live", reply: "stream", status: .running)
    let chat = ChatViewModel(sessionID: "s", api: api, realtime: nil, firstTurn: live, transcriptCache: cache)
    XCTAssertEqual(chat.turns.map(\.id), ["1", "live"])
    XCTAssertEqual(chat.liveTurns, [live])
    XCTAssertEqual(TranscriptViewModel(sessionID: "s", api: api, cache: cache).turns.map(\.id), ["1"])
    chat.stop()
  }

  func testLRUEvictionAndPageCapPreserveContinuation() {
    let cache = SettledTranscriptCache(maxSessions: 2, maxPages: 2)
    let pages = (1...3).map { Page(items: [Samples.quest("\($0)")], nextCursor: "c\($0 + 1)") }
    func save(_ id: String) {
      cache.save(sessionID: id, pageSize: 1, pages: pages, generation: cache.generation)
    }
    save("a")
    save("b")
    let snapshot = cache.load(sessionID: "a", pageSize: 1)
    XCTAssertEqual(snapshot?.pages.count, 2)
    XCTAssertEqual(snapshot?.pages.last?.nextCursor, "c3")
    save("c")
    XCTAssertNil(cache.load(sessionID: "b", pageSize: 1))
    XCTAssertNotNil(cache.load(sessionID: "a", pageSize: 1))
    XCTAssertNil(cache.load(sessionID: "a", pageSize: 2))
  }

  func testRealtimeReconciliationBypassesCachedHistory() async {
    let api = FakeAPI()
    let cache = SettledTranscriptCache()
    let realtime = FakeRealtime()
    await api.setQuestPages([nil: Page(items: [Samples.quest("1")], nextCursor: nil)])
    await TranscriptViewModel(sessionID: "s", api: api, cache: cache).load()
    let chat = ChatViewModel(sessionID: "s", api: api, realtime: realtime, transcriptCache: cache)
    await chat.load()
    let listener = Task { await chat.listen() }
    await eventually { await realtime.listenerCount == 1 }
    await api.setQuestPages([
      nil: Page(items: [Samples.quest("1"), Samples.quest("2")], nextCursor: nil)
    ])
    await realtime.emit(.refetchNeeded)
    await eventually { await MainActor.run { chat.turns.count == 2 } }
    XCTAssertEqual(chat.turns.map(\.id), ["1", "2"])
    let cursors = await api.questCursors
    XCTAssertEqual(cursors, [nil, nil])
    listener.cancel()
    chat.stop()
  }

  func testInvalidationRejectsLateWritesFromPreviousAuthGeneration() async {
    let api = FakeAPI()
    let cache = SettledTranscriptCache()
    let oldGeneration = cache.generation
    let oldModel = TranscriptViewModel(sessionID: "s", api: api, cache: cache)
    await api.setQuestPages([nil: Page(items: [Samples.quest("private")], nextCursor: nil)])
    await oldModel.load()
    cache.invalidate()
    XCTAssertNil(cache.load(sessionID: "s", pageSize: 50))
    cache.save(
      sessionID: "s", pageSize: 50, pages: [Page(items: [Samples.quest("late")], nextCursor: nil)],
      generation: oldGeneration)
    await oldModel.refresh()
    XCTAssertNil(cache.load(sessionID: "s", pageSize: 50))
    XCTAssertTrue(TranscriptViewModel(sessionID: "s", api: api, cache: cache).turns.isEmpty)
  }

  func testReopenedCappedHistoryCanPageForwardAndRefreshAllHeldPages() async {
    let api = FakeAPI()
    let cache = SettledTranscriptCache(maxPages: 1)
    await api.setQuestPages([
      nil: Page(items: [Samples.quest("1")], nextCursor: "c2"),
      "c2": Page(items: [Samples.quest("2")], nextCursor: nil),
    ])
    let first = TranscriptViewModel(sessionID: "s", api: api, pageSize: 1, cache: cache)
    await first.load()
    await first.loadMore()
    let reopened = TranscriptViewModel(sessionID: "s", api: api, pageSize: 1, cache: cache)
    XCTAssertEqual(reopened.turns.map(\.id), ["1"])
    XCTAssertTrue(reopened.hasMore)
    await reopened.loadMore()
    await reopened.refresh()
    XCTAssertEqual(reopened.turns.map(\.id), ["1", "2"])
    let cursors = await api.questCursors
    XCTAssertEqual(cursors, [nil, "c2", "c2", nil, "c2"])
  }
}
