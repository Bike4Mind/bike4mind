import XCTest

@testable import B4MKit

private final class FakeScheduler: BackgroundRefreshScheduling, @unchecked Sendable {
  private let lock = NSLock()
  private var _submits: [(identifier: String, earliestBegin: Date)] = []
  private var _cancels: [String] = []
  var error: (any Error)?

  var submits: [(identifier: String, earliestBegin: Date)] { lock.withLock { _submits } }
  var cancels: [String] { lock.withLock { _cancels } }

  func submit(identifier: String, earliestBegin: Date) throws {
    try lock.withLock {
      if let error { throw error }
      _submits.append((identifier, earliestBegin))
    }
  }

  func cancel(identifier: String) {
    lock.withLock { _cancels.append(identifier) }
  }
}

@MainActor
private final class FakeTask: BackgroundRefreshTask {
  var expirationHandler: (@Sendable () -> Void)?
  private(set) var completions: [Bool] = []
  /// Submits already made at each completion: the system may suspend the app once a task completes.
  private(set) var submitsAtCompletion: [Int] = []
  var onComplete: (() -> Void)?
  private let scheduler: FakeScheduler?

  init(scheduler: FakeScheduler? = nil) { self.scheduler = scheduler }

  func setTaskCompleted(success: Bool) {
    completions.append(success)
    submitsAtCompletion.append(scheduler?.submits.count ?? 0)
    onComplete?()
  }
}

/// Holds a fake sync open until `open()`, ignoring cancellation like a sync joined from another caller.
@MainActor
private final class SyncGate {
  private var continuation: CheckedContinuation<Void, Never>?
  var isWaiting: Bool { continuation != nil }

  func wait() async { await withCheckedContinuation { continuation = $0 } }

  func open() {
    continuation?.resume()
    continuation = nil
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

  func testCancelPendingCancelsTheIdentifier() {
    let scheduler = FakeScheduler()

    refresh(scheduler) { .synced }.cancelPending()

    XCTAssertEqual(scheduler.cancels, ["app.test.busy-block-refresh"])
    XCTAssertTrue(scheduler.submits.isEmpty)
  }

  func testRefusedSubmitIsSwallowed() {
    let scheduler = FakeScheduler()
    scheduler.error = SubmitRefused()

    refresh(scheduler) { .synced }.scheduleNext()

    XCTAssertTrue(scheduler.submits.isEmpty)
  }

  func testSyncedRunCompletesSuccessfullyAndRearms() async {
    let scheduler = FakeScheduler()
    let task = FakeTask(scheduler: scheduler)

    await run(refresh(scheduler) { .synced }, until: task)

    XCTAssertEqual(task.completions, [true])
    XCTAssertEqual(scheduler.submits.count, 1)
    XCTAssertEqual(task.submitsAtCompletion, [1])
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
    let task = FakeTask(scheduler: scheduler)
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
    XCTAssertEqual(task.submitsAtCompletion, [1])
    XCTAssertNil(task.expirationHandler)
  }

  func testExpirationCompletesOnceWhenTheSyncIgnoresCancelAndFinishesLater() async {
    let scheduler = FakeScheduler()
    let task = FakeTask(scheduler: scheduler)
    let gate = SyncGate()
    let refresh = refresh(scheduler) {
      await gate.wait()
      return .synced
    }
    let completed = expectation(description: "completed")
    task.onComplete = { completed.fulfill() }

    refresh.handle(task)
    for _ in 0..<10_000 where !gate.isWaiting { await Task.yield() }
    XCTAssertTrue(gate.isWaiting)
    task.expirationHandler?()
    await fulfillment(of: [completed], timeout: 2)
    gate.open()
    for _ in 0..<10 { await Task.yield() }

    XCTAssertEqual(task.completions, [false])
    XCTAssertEqual(scheduler.submits.count, 1)
    XCTAssertEqual(task.submitsAtCompletion, [1])
  }

  func testExpirationAfterCompletionDoesNothing() async {
    let scheduler = FakeScheduler()
    let task = FakeTask()
    let refresh = refresh(scheduler) { .synced }
    let expire = { () -> (@Sendable () -> Void)? in
      refresh.handle(task)
      return task.expirationHandler
    }()

    for _ in 0..<10_000 where task.completions.isEmpty { await Task.yield() }
    for _ in 0..<10 { await Task.yield() }
    expire?()
    for _ in 0..<10 { await Task.yield() }

    XCTAssertEqual(task.completions, [true])
    XCTAssertEqual(scheduler.submits.count, 1)
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
