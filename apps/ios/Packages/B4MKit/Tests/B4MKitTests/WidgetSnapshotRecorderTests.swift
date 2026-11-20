import XCTest

@testable import B4MKit

final class WidgetSnapshotRecorderTests: XCTestCase {
  private func makeRecorder(
    store: any WidgetSnapshotStoring = InMemoryWidgetSnapshotStore(), reloader: RecordingReloader = RecordingReloader()
  ) -> (WidgetSnapshotRecorder, any WidgetSnapshotStoring, RecordingReloader) {
    (WidgetSnapshotRecorder(store: store, reloader: reloader, now: { referenceDate }), store, reloader)
  }

  private func turn(
    _ id: String, status: QuestTurn.Status?, pending: PendingAction? = nil
  ) -> QuestTurn {
    QuestTurn(id: id, prompt: "p", reply: nil, status: status, createdAt: referenceDate, pendingAction: pending)
  }

  func testCreditsAreWrittenAndOnlyReloadWhenTheBalanceChanged() async {
    let (recorder, store, reloader) = makeRecorder()
    await recorder.recordCredits(CreditBalance(credits: 100))
    await recorder.recordCredits(CreditBalance(credits: 100))
    await recorder.recordCredits(CreditBalance(credits: 90))
    XCTAssertEqual(store.load()?.credits?.balance, 90)
    XCTAssertEqual(reloader.reloads, [[WidgetKind.credits], [WidgetKind.credits]])
  }

  func testRunningTurnsAggregateAcrossSessionsAndLeadWithTheMostRecentlyTouched() async {
    let clock = Clock()
    let store = InMemoryWidgetSnapshotStore()
    let recorder = WidgetSnapshotRecorder(store: store, reloader: RecordingReloader(), now: { clock.now })
    await recorder.recordTurns(sessionID: "a", sessionTitle: "Alpha", turns: [turn("1", status: .running)])
    clock.advance(10)
    await recorder.recordTurns(
      sessionID: "b", sessionTitle: "Beta", turns: [turn("2", status: .pending), turn("3", status: .running)])

    let running = store.load()?.runningAgents
    XCTAssertEqual(running?.count, 3)
    XCTAssertEqual(running?.top, .init(sessionID: "b", title: "Beta", status: "running"))
  }

  func testASessionLeftMidRunAgesOutInsteadOfBeingRepublishedAsRunning() async {
    let clock = Clock()
    let store = InMemoryWidgetSnapshotStore()
    let recorder = WidgetSnapshotRecorder(store: store, reloader: RecordingReloader(), now: { clock.now })
    await recorder.recordTurns(sessionID: "a", sessionTitle: "Alpha", turns: [turn("1", status: .running)])
    clock.advance(60)
    await recorder.recordTurns(sessionID: "b", sessionTitle: "Beta", turns: [turn("2", status: .running)])
    XCTAssertEqual(store.load()?.runningAgents?.observedAt, clock.now, "stamped with the lead's last sighting")

    // Only session B is open now; A is never observed again.
    clock.advance(WidgetEntryMapper.runningAgentsFreshness)
    await recorder.recordTurns(sessionID: "b", sessionTitle: "Beta", turns: [turn("2", status: .done)])
    let running = store.load()?.runningAgents
    XCTAssertEqual(running?.count, 0, "A is older than the freshness window and no longer counted")
    XCTAssertNil(running?.top)
  }

  func testPendingApprovalOutranksRunning() async {
    let (recorder, store, _) = makeRecorder()
    let approval = PendingAction(tool: "web_browse", parameters: [:], requestedAt: referenceDate)
    await recorder.recordTurns(
      sessionID: "a", sessionTitle: "Alpha",
      turns: [turn("1", status: .running), turn("2", status: .pending, pending: approval)])
    XCTAssertEqual(store.load()?.runningAgents?.top?.status, "approval")
  }

  func testSettledTurnsDropTheSessionFromTheAggregate() async {
    let (recorder, store, reloader) = makeRecorder()
    await recorder.recordTurns(sessionID: "a", sessionTitle: "Alpha", turns: [turn("1", status: .running)])
    await recorder.recordTurns(sessionID: "a", sessionTitle: "Alpha", turns: [turn("1", status: .done)])
    XCTAssertEqual(store.load()?.runningAgents?.count, 0)
    XCTAssertNil(store.load()?.runningAgents?.top)
    XCTAssertEqual(reloader.reloads.count, 2)
  }

  func testStreamingFramesThatChangeNothingVisibleDoNotReload() async {
    let (recorder, _, reloader) = makeRecorder()
    for _ in 0..<5 {
      await recorder.recordTurns(sessionID: "a", sessionTitle: "Alpha", turns: [turn("1", status: .running)])
    }
    XCTAssertEqual(reloader.reloads.count, 1)
  }

  func testTurnsWithNoStatusAreNotCountedAsRunning() async {
    let (recorder, store, _) = makeRecorder()
    await recorder.recordTurns(sessionID: "a", sessionTitle: "Alpha", turns: [turn("1", status: nil)])
    XCTAssertEqual(store.load()?.runningAgents?.count, 0)
  }

  func testClearRunningForgetsEverySession() async {
    let (recorder, store, _) = makeRecorder()
    await recorder.recordTurns(sessionID: "a", sessionTitle: "Alpha", turns: [turn("1", status: .running)])
    await recorder.clearRunning()
    XCTAssertEqual(store.load()?.runningAgents?.count, 0)
  }

  func testRecordingKeepsUnrelatedFields() async {
    let (recorder, store, _) = makeRecorder()
    await recorder.recordCredits(CreditBalance(credits: 5))
    await recorder.recordTurns(sessionID: "a", sessionTitle: "Alpha", turns: [turn("1", status: .running)])
    XCTAssertEqual(store.load()?.credits?.balance, 5)
  }

  func testUnavailableContainerIsSilentAndNeverReloads() async {
    let (recorder, store, reloader) = makeRecorder(store: unavailableStore())
    await recorder.recordCredits(CreditBalance(credits: 5))
    await recorder.recordTurns(sessionID: "a", sessionTitle: "Alpha", turns: [turn("1", status: .running)])
    await recorder.recordLatestGeneration(mediaID: "m", title: "t", createdAt: referenceDate, thumbnail: Data([1]))
    XCTAssertNil(store.load())
    XCTAssertTrue(reloader.reloads.isEmpty)
  }

  func testLatestGenerationStoresThumbnailAndSkipsAnUnchangedRepeat() async {
    let (recorder, store, reloader) = makeRecorder()
    await recorder.recordLatestGeneration(
      mediaID: "m1", title: "Lighthouse", createdAt: referenceDate, thumbnail: Data([1]))
    await recorder.recordLatestGeneration(
      mediaID: "m1", title: "Lighthouse", createdAt: referenceDate, thumbnail: Data([1]))
    XCTAssertEqual(store.load()?.latestGeneration?.thumbnailFileName, "m1")
    XCTAssertEqual(reloader.reloads, [[WidgetKind.latestGeneration]])
  }

  func testLatestGenerationUpgradesATitleOnlyEntryOnceAThumbnailArrives() async {
    let (recorder, store, reloader) = makeRecorder()
    await recorder.recordLatestGeneration(mediaID: "m1", title: "Lighthouse", createdAt: referenceDate, thumbnail: nil)
    XCTAssertNil(store.load()?.latestGeneration?.thumbnailFileName)
    await recorder.recordLatestGeneration(
      mediaID: "m1", title: "Lighthouse", createdAt: referenceDate, thumbnail: Data([1]))
    XCTAssertNotNil(store.load()?.latestGeneration?.thumbnailFileName)
    XCTAssertEqual(reloader.reloads.count, 2)
  }

  func testSignOutWipesTheStoreAndReloadsEveryWidget() async {
    let (recorder, store, reloader) = makeRecorder()
    await recorder.recordCredits(CreditBalance(credits: 5))
    await recorder.recordTurns(sessionID: "a", sessionTitle: "Alpha", turns: [turn("1", status: .running)])
    await recorder.signOut()
    XCTAssertNil(store.load())
    XCTAssertEqual(reloader.reloads.last, WidgetKind.all)
    // A running session from the previous account must not resurface in the next snapshot.
    await recorder.recordCredits(CreditBalance(credits: 7))
    XCTAssertNil(store.load()?.runningAgents)
  }

  func testReplaceWritesTheSnapshotAndReloadsEveryWidget() async {
    let (recorder, store, reloader) = makeRecorder()
    await recorder.replace(with: .fixture(now: referenceDate))
    XCTAssertEqual(store.load(), .fixture(now: referenceDate))
    XCTAssertEqual(reloader.reloads, [WidgetKind.all])
  }
}

private final class Clock: @unchecked Sendable {
  private let lock = NSLock()
  private var current = referenceDate

  var now: Date { lock.withLock { current } }
  func advance(_ seconds: TimeInterval) { lock.withLock { current = current.addingTimeInterval(seconds) } }
}
