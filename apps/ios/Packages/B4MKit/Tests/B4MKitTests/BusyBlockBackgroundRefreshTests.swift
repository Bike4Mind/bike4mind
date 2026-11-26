import XCTest

@testable import B4MKit

private final class FakeScheduler: BackgroundRefreshScheduling, @unchecked Sendable {
  private let lock = NSLock()
  private var _submits: [(identifier: String, earliestBegin: Date)] = []
  var error: (any Error)?

  var submits: [(identifier: String, earliestBegin: Date)] { lock.withLock { _submits } }

  func submit(identifier: String, earliestBegin: Date) throws {
    try lock.withLock {
      if let error { throw error }
      _submits.append((identifier, earliestBegin))
    }
  }
}

@MainActor
private final class FakeTask: BackgroundRefreshTask {
  var expirationHandler: (@Sendable () -> Void)?
  private(set) var completions: [Bool] = []
  var onComplete: (() -> Void)?

  func setTaskCompleted(success: Bool) {
    completions.append(success)
    onComplete?()
  }
}

private struct SubmitRefused: Error {}

@MainActor
final class BusyBlockBackgroundRefreshTests: XCTestCase {
  private let now = Date(timeIntervalSince1970: 1_800_000_000)

  private func refresh(
    _ scheduler: FakeScheduler, sync: @escaping @MainActor () async -> BusyBlockSyncOutcome
  ) -> BusyBlockBackgroundRefresh {
    BusyBlockBackgroundRefresh(
      identifier: "app.test.busy-block-refresh", scheduler: scheduler, now: { [now] in now }, sync: sync)
  }

  private func run(_ refresh: BusyBlockBackgroundRefresh, until task: FakeTask) async {
    let done = expectation(description: "completed")
    task.onComplete = { done.fulfill() }
    refresh.handle(task)
    await fulfillment(of: [done], timeout: 2)
    await Task.yield()
  }

  func testScheduleNextSubmitsTheIdentifierAnIntervalOut() {
    let scheduler = FakeScheduler()

    refresh(scheduler) { .synced }.scheduleNext()

    XCTAssertEqual(scheduler.submits.map(\.identifier), ["app.test.busy-block-refresh"])
    XCTAssertEqual(scheduler.submits.first?.earliestBegin, now.addingTimeInterval(BusyBlockBackgroundRefresh.interval))
  }

  func testRefusedSubmitIsSwallowed() {
    let scheduler = FakeScheduler()
    scheduler.error = SubmitRefused()

    refresh(scheduler) { .synced }.scheduleNext()

    XCTAssertTrue(scheduler.submits.isEmpty)
  }

  func testSyncedRunCompletesSuccessfullyAndRearms() async {
    let scheduler = FakeScheduler()
    let task = FakeTask()

    await run(refresh(scheduler) { .synced }, until: task)

    XCTAssertEqual(task.completions, [true])
    XCTAssertEqual(scheduler.submits.count, 1)
  }

  func testRunSkippedBehindAnInFlightSyncStillSucceeds() async {
    let scheduler = FakeScheduler()
    let task = FakeTask()

    await run(refresh(scheduler) { .skipped(.inFlight) }, until: task)

    XCTAssertEqual(task.completions, [true])
    XCTAssertEqual(scheduler.submits.count, 1)
  }

  func testFailedRunCompletesUnsuccessfullyAndRearms() async {
    let scheduler = FakeScheduler()
    let task = FakeTask()

    await run(refresh(scheduler) { .failed }, until: task)

    XCTAssertEqual(task.completions, [false])
    XCTAssertEqual(scheduler.submits.count, 1)
  }

  func testRunThatOnlyThisAppCanUnblockDoesNotRearm() async {
    for outcome: BusyBlockSyncOutcome in [.skipped(.neverAsked), .skipped(.signedOut)] {
      let scheduler = FakeScheduler()
      let task = FakeTask()

      await run(refresh(scheduler) { outcome }, until: task)

      XCTAssertEqual(task.completions, [true], "\(outcome)")
      XCTAssertTrue(scheduler.submits.isEmpty, "\(outcome)")
    }
  }

  func testRunWithTheOptInOffRearmsAtTheLongerInterval() async {
    let scheduler = FakeScheduler()
    let task = FakeTask()

    await run(refresh(scheduler) { .skipped(.disabled) }, until: task)

    XCTAssertEqual(task.completions, [true])
    XCTAssertEqual(
      scheduler.submits.map(\.earliestBegin), [now.addingTimeInterval(BusyBlockBackgroundRefresh.disabledInterval)])
  }

  func testBackgroundEdgeSchedulesForTheLastKnownOutcome() {
    let scheduler = FakeScheduler()
    let refresh = refresh(scheduler) { .synced }

    refresh.scheduleNext(after: .skipped(.neverAsked))
    refresh.scheduleNext(after: .skipped(.signedOut))
    refresh.scheduleNext(after: .skipped(.disabled))
    refresh.scheduleNext(after: nil)

    XCTAssertEqual(
      scheduler.submits.map(\.earliestBegin),
      [
        now.addingTimeInterval(BusyBlockBackgroundRefresh.disabledInterval),
        now.addingTimeInterval(BusyBlockBackgroundRefresh.interval),
      ])
  }

  func testExpirationCancelsTheSyncAndCompletesOnceUnsuccessfully() async {
    let scheduler = FakeScheduler()
    let task = FakeTask()
    let cancelled = expectation(description: "sync cancelled")
    let refresh = refresh(scheduler) {
      try? await Task.sleep(for: .seconds(30))
      if Task.isCancelled { cancelled.fulfill() }
      return Task.isCancelled ? .failed : .synced
    }
    let completed = expectation(description: "completed")
    task.onComplete = { completed.fulfill() }

    refresh.handle(task)
    await Task.yield()
    let expire = try? XCTUnwrap(task.expirationHandler)
    expire?()
    await fulfillment(of: [completed, cancelled], timeout: 2)
    for _ in 0..<5 { await Task.yield() }

    XCTAssertEqual(task.completions, [false])
    XCTAssertEqual(scheduler.submits.count, 1)
    XCTAssertNil(task.expirationHandler)
  }

  func testRunDuringAUserSaveJoinsItAndRearmsForItsOutcome() async {
    let scheduler = FakeScheduler()
    let task = FakeTask()
    let api = FakeBusyBlocksAPI(enabled: true)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .authorized))
    await api.holdSave()
    let save = Task { try await syncer.save(enabled: false) }
    while await api.saveAttempts == 0 { await Task.yield() }

    let refresh = refresh(scheduler) { await syncer.syncJoiningInFlight() }
    let ran = Task { await run(refresh, until: task) }
    for _ in 0..<5 { await Task.yield() }
    XCTAssertTrue(task.completions.isEmpty)
    await api.release()
    await ran.value
    _ = try? await save.value

    XCTAssertEqual(task.completions, [true])
    let rearmedAt = now.addingTimeInterval(BusyBlockBackgroundRefresh.disabledInterval)
    XCTAssertEqual(scheduler.submits.map(\.earliestBegin), [rearmedAt])
    let reads = await api.reads
    XCTAssertEqual(reads, 0)
  }

  func testDelayPerOutcome() {
    let interval = BusyBlockBackgroundRefresh.interval
    XCTAssertEqual(BusyBlockBackgroundRefresh.delay(after: nil), interval)
    XCTAssertEqual(BusyBlockBackgroundRefresh.delay(after: .synced), interval)
    XCTAssertEqual(BusyBlockBackgroundRefresh.delay(after: .failed), interval)
    XCTAssertEqual(BusyBlockBackgroundRefresh.delay(after: .skipped(.inFlight)), interval)
    XCTAssertEqual(BusyBlockBackgroundRefresh.delay(after: .skipped(.throttled)), interval)
    XCTAssertEqual(
      BusyBlockBackgroundRefresh.delay(after: .skipped(.disabled)), BusyBlockBackgroundRefresh.disabledInterval)
    XCTAssertNil(BusyBlockBackgroundRefresh.delay(after: .skipped(.neverAsked)))
    XCTAssertNil(BusyBlockBackgroundRefresh.delay(after: .skipped(.signedOut)))
  }
}
