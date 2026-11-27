import XCTest

@testable import B4MKit

actor FakeBusyBlocksAPI: BusyBlocksAPI {
  var stored: BusyBlocksState
  private(set) var saves: [(enabled: Bool, blocks: [BusyBlock])] = []
  private(set) var reads = 0
  var stateError: (any Error)?
  var saveError: (any Error)?
  /// While set, `state()` or `save` suspends until `release()` so a test can overlap two calls.
  private var gates: [CheckedContinuation<Void, Never>] = []
  private var holdsState = false
  private var holdsSave = false
  private(set) var saveAttempts = 0
  /// When set, `state()` throws once the calling task was cancelled, like a real network request would.
  private var throwsWhenCancelled = false

  init(enabled: Bool) { stored = BusyBlocksState(enabled: enabled, blocks: []) }

  func failState(with error: (any Error)?) { stateError = error }
  func failSave(with error: (any Error)?) { saveError = error }
  func holdState() { holdsState = true }
  func holdSave() { holdsSave = true }
  func throwWhenCancelled() { throwsWhenCancelled = true }
  func stopHolding() { holdsState = false }
  func setEnabled(_ enabled: Bool) { stored = BusyBlocksState(enabled: enabled, blocks: stored.blocks) }
  func release() {
    holdsState = false
    holdsSave = false
    gates.forEach { $0.resume() }
    gates = []
  }
  /// Lets only the earliest held call continue; later ones stay held.
  func releaseOldest() { if !gates.isEmpty { gates.removeFirst().resume() } }

  func state() async throws -> BusyBlocksState {
    reads += 1
    let read = stored
    if holdsState { await withCheckedContinuation { gates.append($0) } }
    if throwsWhenCancelled { try Task.checkCancellation() }
    if let stateError { throw stateError }
    return read
  }

  func save(enabled: Bool, blocks: [BusyBlock]) async throws -> BusyBlocksState {
    saveAttempts += 1
    if holdsSave { await withCheckedContinuation { gates.append($0) } }
    if let saveError { throw saveError }
    saves.append((enabled, blocks))
    stored = BusyBlocksState(enabled: enabled, blocks: blocks)
    return stored
  }
}

final class FakeReader: BusyBlockReader, @unchecked Sendable {
  var status: BusyBlockAccess
  var grants: Bool
  var events: [CalendarEventSample]
  private(set) var requested = 0

  init(access: BusyBlockAccess, grants: Bool = true, events: [CalendarEventSample] = []) {
    self.status = access
    self.grants = grants
    self.events = events
  }

  func access() -> BusyBlockAccess { status }

  func requestAccess() async -> Bool {
    requested += 1
    if grants { status = .authorized }
    return grants
  }

  func events(from start: Date, to end: Date) -> [CalendarEventSample] { events }
}

@MainActor
final class BusyBlockSyncerTests: XCTestCase {
  private let now = Date(timeIntervalSince1970: 1_800_000_000)

  private func events() -> [CalendarEventSample] {
    [
      CalendarEventSample(start: now, end: now.addingTimeInterval(1800), isAllDay: false, availability: .busy),
      CalendarEventSample(start: now, end: now.addingTimeInterval(86400), isAllDay: true, availability: .busy),
      CalendarEventSample(start: now, end: now.addingTimeInterval(600), isAllDay: false, availability: .free),
    ]
  }

  /// Yields until `condition` holds, failing the test instead of hanging when it never does.
  private func waitUntil(_ what: String, _ condition: () async -> Bool) async {
    for _ in 0..<10_000 {
      if await condition() { return }
      await Task.yield()
    }
    XCTFail("timed out waiting for \(what)")
  }

  func testSyncPutsOnlyBusyTimedEventsWhenEnabled() async {
    let api = FakeBusyBlocksAPI(enabled: true)
    let syncer = BusyBlockSyncer(
      api: api, reader: FakeReader(access: .authorized, events: events()), now: { [now] in now })

    await syncer.sync()

    let saves = await api.saves
    XCTAssertEqual(saves.count, 1)
    XCTAssertEqual(saves.first?.enabled, true)
    XCTAssertEqual(saves.first?.blocks, [BusyBlock(start: now, end: now.addingTimeInterval(1800))])
  }

  func testSyncNeverWritesWhenTheServerOptInIsOff() async {
    let api = FakeBusyBlocksAPI(enabled: false)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .authorized, events: events()))

    await syncer.sync()

    let saves = await api.saves
    XCTAssertTrue(saves.isEmpty)
  }

  func testSyncSkipsTheServerWhenCalendarAccessWasNeverAsked() async {
    let api = FakeBusyBlocksAPI(enabled: true)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .notDetermined))

    await syncer.sync()

    let reads = await api.reads
    XCTAssertEqual(reads, 0)
  }

  func testRevokedAccessSyncsAnEmptyList() async {
    let api = FakeBusyBlocksAPI(enabled: true)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .denied, events: events()))

    await syncer.sync()

    let saves = await api.saves
    XCTAssertEqual(saves.count, 1)
    XCTAssertEqual(saves.first?.blocks, [])
  }

  func testRepeatSyncWithinTheIntervalIsSkippedUnlessForced() async {
    let api = FakeBusyBlocksAPI(enabled: true)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .authorized), now: { [now] in now })

    await syncer.sync()
    await syncer.sync()
    await syncer.sync(force: true)

    let saves = await api.saves
    XCTAssertEqual(saves.count, 2)
  }

  func testOutcomeIsSyncedWhenBlocksAreSaved() async {
    let api = FakeBusyBlocksAPI(enabled: true)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .authorized, events: events()))

    let outcome = await syncer.sync()

    XCTAssertEqual(outcome, .synced)
  }

  func testRevokedAccessReportsSyncedWithAnEmptyPut() async {
    let api = FakeBusyBlocksAPI(enabled: true)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .denied, events: events()))

    let outcome = await syncer.sync()

    XCTAssertEqual(outcome, .synced)
    let saves = await api.saves
    XCTAssertEqual(saves.map(\.blocks), [[]])
  }

  func testNeverAskedSkipsWithoutCallingTheServer() async {
    let api = FakeBusyBlocksAPI(enabled: true)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .notDetermined))

    let outcome = await syncer.sync(force: true)

    XCTAssertEqual(outcome, .skipped(.neverAsked))
    let reads = await api.reads
    XCTAssertEqual(reads, 0)
  }

  func testServerOptInOffSkipsAsDisabledWithoutSaving() async {
    let api = FakeBusyBlocksAPI(enabled: false)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .authorized, events: events()))

    let outcome = await syncer.sync(force: true)

    XCTAssertEqual(outcome, .skipped(.disabled))
    let saves = await api.saves
    XCTAssertTrue(saves.isEmpty)
  }

  func testThrottledSyncReportsSkipped() async {
    let api = FakeBusyBlocksAPI(enabled: true)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .authorized), now: { [now] in now })

    await syncer.sync()
    let outcome = await syncer.sync()

    XCTAssertEqual(outcome, .skipped(.throttled))
  }

  func testForcedSyncInsideTheIntervalStillSyncs() async {
    let api = FakeBusyBlocksAPI(enabled: true)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .authorized), now: { [now] in now })

    await syncer.sync()
    let outcome = await syncer.sync(force: true)

    XCTAssertEqual(outcome, .synced)
  }

  func testFailedSaveReportsFailedAndDoesNotThrottleTheRetry() async {
    let api = FakeBusyBlocksAPI(enabled: true)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .authorized), now: { [now] in now })
    await api.failSave(with: APIError.server(status: 503))

    let failed = await syncer.sync()
    await api.failSave(with: nil)
    let retried = await syncer.sync()

    XCTAssertEqual(failed, .failed)
    XCTAssertEqual(retried, .synced)
  }

  func testOfflineStateReadFailsAndKeepsTheServerBlocks() async {
    let api = FakeBusyBlocksAPI(enabled: true)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .authorized, events: events()))
    await api.failState(with: APIError.offline)

    let outcome = await syncer.sync(force: true)

    XCTAssertEqual(outcome, .failed)
    let saves = await api.saves
    XCTAssertTrue(saves.isEmpty)
  }

  func testCancelledRunReportsFailed() async {
    let api = FakeBusyBlocksAPI(enabled: true)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .authorized))
    await api.failState(with: CancellationError())

    let outcome = await syncer.sync(force: true)

    XCTAssertEqual(outcome, .failed)
  }

  func testEndedSessionSkipsAsSignedOut() async {
    let api = FakeBusyBlocksAPI(enabled: true)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .authorized))
    await api.failState(with: APIError.signedOut)

    let outcome = await syncer.sync(force: true)

    XCTAssertEqual(outcome, .skipped(.signedOut))
  }

  func testSecondSyncWhileOneIsRunningSkipsAsInFlight() async {
    let api = FakeBusyBlocksAPI(enabled: true)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .authorized))
    await api.holdState()

    let first = Task { await syncer.sync(force: true) }
    await waitUntil("the state read") { await api.reads > 0 }
    let second = await syncer.sync(force: true)
    await api.release()

    XCTAssertEqual(second, .skipped(.inFlight))
    let firstOutcome = await first.value
    XCTAssertEqual(firstOutcome, .synced)
  }

  func testTogglingOffDuringASyncEndsDisabledWithNoBlocks() async {
    let api = FakeBusyBlocksAPI(enabled: true)
    let reader = FakeReader(access: .authorized, events: events())
    let syncer = BusyBlockSyncer(api: api, reader: reader, now: { [now] in now })
    let model = BusyBlockBriefViewModel(api: api, reader: reader, syncer: syncer)
    await model.load()
    await api.holdState()

    let sync = Task { await syncer.sync(force: true) }
    while await api.reads < 2 { await Task.yield() }
    let toggle = Task { await model.setEnabled(false) }
    while model.isEnabled { await Task.yield() }
    let savesWhileHeld = await api.saves
    XCTAssertTrue(savesWhileHeld.isEmpty)
    await api.release()
    _ = await sync.value
    await toggle.value

    let saves = await api.saves
    XCTAssertEqual(saves.map(\.enabled), [true, false])
    XCTAssertEqual(saves.last?.blocks, [])
    let stored = await api.stored
    XCTAssertFalse(stored.enabled)
    XCTAssertFalse(model.isEnabled)
  }

  func testSyncDuringAUserSaveSkipsAsInFlightWithoutReadingTheServer() async {
    let api = FakeBusyBlocksAPI(enabled: true)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .authorized))
    await api.holdSave()

    let save = Task { try await syncer.save(enabled: false) }
    while await api.saveAttempts == 0 { await Task.yield() }
    let outcome = await syncer.sync(force: true)
    await api.release()
    _ = try? await save.value

    XCTAssertEqual(outcome, .skipped(.inFlight))
    let reads = await api.reads
    XCTAssertEqual(reads, 0)
  }

  func testFailedUserSaveReleasesTheLock() async {
    let api = FakeBusyBlocksAPI(enabled: true)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .authorized))
    await api.failSave(with: APIError.server(status: 503))

    let failed = try? await syncer.save(enabled: true)
    await api.failSave(with: nil)
    let outcome = await syncer.sync(force: true)

    XCTAssertNil(failed)
    XCTAssertEqual(outcome, .synced)
  }

  func testJoiningCallerGetsTheInFlightOutcomeWithoutASecondRead() async {
    let cases: [((any Error)?, BusyBlockSyncOutcome)] = [(nil, .synced), (URLError(.notConnectedToInternet), .failed)]
    for (stateError, expected) in cases {
      let api = FakeBusyBlocksAPI(enabled: true)
      let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .authorized))
      if let stateError { await api.failState(with: stateError) }
      await api.holdState()

      let first = Task { await syncer.sync(force: true) }
      await waitUntil("the state read") { await api.reads > 0 }
      let joined = Task { await syncer.syncJoiningInFlight() }
      for _ in 0..<5 { await Task.yield() }
      await api.release()

      let joinedOutcome = await joined.value
      let firstOutcome = await first.value
      XCTAssertEqual(joinedOutcome, expected)
      XCTAssertEqual(firstOutcome, expected)
      let reads = await api.reads
      XCTAssertEqual(reads, 1)
    }
  }

  func testJoiningWithNothingInFlightRunsAForcedSync() async {
    let api = FakeBusyBlocksAPI(enabled: true)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .authorized), now: { [now] in now })
    await syncer.sync()

    let outcome = await syncer.syncJoiningInFlight()

    XCTAssertEqual(outcome, .synced)
    let saves = await api.saves
    XCTAssertEqual(saves.count, 2)
  }

  func testSyncInFlightAtSessionStartDoesNotThrottleTheNextOne() async {
    let api = FakeBusyBlocksAPI(enabled: true)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .authorized), now: { [now] in now })
    await api.holdState()

    let first = Task { await syncer.sync() }
    while await api.reads == 0 { await Task.yield() }
    syncer.sessionDidStart()
    await api.release()
    _ = await first.value
    let next = await syncer.sync()

    XCTAssertEqual(next, .synced)
  }

  func testLastOutcomeIgnoresThrottledAndInFlightSkips() async {
    let api = FakeBusyBlocksAPI(enabled: false)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .authorized), now: { [now] in now })
    XCTAssertNil(syncer.lastOutcome)

    await syncer.sync()
    XCTAssertEqual(syncer.lastOutcome, .skipped(.disabled))
    await api.holdState()
    let first = Task { await syncer.sync(force: true) }
    await waitUntil("the second state read") { await api.reads > 1 }
    let inFlight = await syncer.sync(force: true)
    XCTAssertEqual(inFlight, .skipped(.inFlight))
    XCTAssertEqual(syncer.lastOutcome, .skipped(.disabled))
    await api.release()
    _ = await first.value
    let skipped = await syncer.sync()
    XCTAssertEqual(skipped, .skipped(.throttled))
    XCTAssertEqual(syncer.lastOutcome, .skipped(.disabled))
  }

  func testSessionStartForgetsTheSignedOutOutcomeAndTheThrottle() async {
    let api = FakeBusyBlocksAPI(enabled: true)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .authorized), now: { [now] in now })
    await syncer.sync()
    await api.failState(with: APIError.signedOut)
    await syncer.sync(force: true)
    XCTAssertEqual(syncer.lastOutcome, .skipped(.signedOut))

    syncer.sessionDidStart()

    XCTAssertNil(syncer.lastOutcome)
    await api.failState(with: nil)
    let outcome = await syncer.sync()
    XCTAssertEqual(outcome, .synced)
  }

  func testSyncThatReadTheOptInBeforeASessionStartWritesNothing() async {
    let api = FakeBusyBlocksAPI(enabled: true)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .authorized))
    await api.holdState()

    let first = Task { await syncer.sync(force: true) }
    while await api.reads == 0 { await Task.yield() }
    syncer.sessionDidStart()
    await api.release()
    _ = await first.value

    let saveAttempts = await api.saveAttempts
    XCTAssertEqual(saveAttempts, 0)
    XCTAssertNil(syncer.lastOutcome)
  }

  func testUserSaveQueuedBehindASyncIsDroppedAtSessionStart() async {
    let api = FakeBusyBlocksAPI(enabled: true)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .authorized))
    await api.holdState()

    let sync = Task { await syncer.sync(force: true) }
    while await api.reads == 0 { await Task.yield() }
    let save = Task { try await syncer.save(enabled: false) }
    await waitUntil("the save to park behind the sync") { syncer.parkedWaits == 1 }
    syncer.sessionDidStart()
    await api.release()
    _ = await sync.value
    let saved = try? await save.value

    XCTAssertNil(saved)
    let saveAttempts = await api.saveAttempts
    XCTAssertEqual(saveAttempts, 0)
  }

  func testNewSessionSyncHoldsTheLockWhileThePreviousSessionsSyncIsStillRunning() async {
    let api = FakeBusyBlocksAPI(enabled: true)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .authorized), now: { [now] in now })
    await api.holdState()

    let old = Task { await syncer.sync() }
    while await api.reads == 0 { await Task.yield() }
    syncer.sessionDidStart()
    let new = Task { await syncer.sync() }
    while await api.reads < 2 { await Task.yield() }
    await api.releaseOldest()
    _ = await old.value
    let whileNewRuns = await syncer.sync(force: true)
    await api.release()
    let newOutcome = await new.value

    XCTAssertEqual(whileNewRuns, .skipped(.inFlight))
    XCTAssertEqual(newOutcome, .synced)
    let saves = await api.saves
    XCTAssertEqual(saves.count, 1)
  }

  func testNewSessionSyncWaitsForAToggleOffAlreadySent() async {
    let api = FakeBusyBlocksAPI(enabled: true)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .authorized))
    await api.holdSave()

    let save = Task { try await syncer.save(enabled: false) }
    while await api.saveAttempts == 0 { await Task.yield() }
    syncer.sessionDidStart()
    let sync = Task { await syncer.sync() }
    await waitUntil("the sync to park behind the sent save") { syncer.parkedWaits == 1 }
    await api.release()
    _ = try? await save.value
    let outcome = await sync.value

    XCTAssertEqual(outcome, .skipped(.disabled))
    let saves = await api.saves.map(\.enabled)
    XCTAssertEqual(saves, [false])
  }

  func testSaveInANewSessionWaitsForTheSaveAlreadySentByTheOldOne() async {
    let api = FakeBusyBlocksAPI(enabled: true)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .authorized))
    await api.holdSave()

    let old = Task { try await syncer.save(enabled: false) }
    while await api.saveAttempts == 0 { await Task.yield() }
    syncer.sessionDidStart()
    let new = Task { try await syncer.save(enabled: true) }
    await waitUntil("the new save to park behind the sent one") { syncer.parkedWaits == 1 }
    let attemptsBeforeOldLanded = await api.saveAttempts
    await api.release()
    _ = try? await old.value
    await api.release()
    _ = try? await new.value

    XCTAssertEqual(attemptsBeforeOldLanded, 1)
    let saves = await api.saves.map(\.enabled)
    XCTAssertEqual(saves, [false, true])
  }

  func testSyncFromThePreviousSessionDoesNotOverwriteTheReset() async {
    let api = FakeBusyBlocksAPI(enabled: false)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .authorized), now: { [now] in now })
    await api.holdState()
    let stale = Task { await syncer.sync(force: true) }
    await waitUntil("the state read") { await api.reads > 0 }

    syncer.sessionDidStart()
    await api.release()
    let staleOutcome = await stale.value

    XCTAssertEqual(staleOutcome, .skipped(.signedOut))
    XCTAssertNil(syncer.lastOutcome)
    await api.setEnabled(true)
    let outcome = await syncer.sync()
    XCTAssertEqual(outcome, .synced)
  }

  func testPreviousSessionsSyncFinishingLateLeavesTheNewSessionsOutcome() async {
    let api = FakeBusyBlocksAPI(enabled: true)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .authorized), now: { [now] in now })
    await api.holdState()
    let stale = Task { await syncer.sync(force: true) }
    await waitUntil("the state read") { await api.reads > 0 }

    syncer.sessionDidStart()
    await api.stopHolding()
    let outcome = await syncer.sync()
    await api.release()
    let staleOutcome = await stale.value

    XCTAssertEqual(outcome, .synced)
    XCTAssertEqual(staleOutcome, .skipped(.signedOut))
    XCTAssertEqual(syncer.lastOutcome, .synced)
    let saves = await api.saves.count
    XCTAssertEqual(saves, 1)
  }

  func testCancellingTheCallerFailsTheSyncAndLetsTheNextOneRun() async {
    let api = FakeBusyBlocksAPI(enabled: true)
    let syncer = BusyBlockSyncer(api: api, reader: FakeReader(access: .authorized))
    await api.throwWhenCancelled()
    await api.holdState()
    let first = Task { await syncer.sync(force: true) }
    await waitUntil("the state read") { await api.reads > 0 }

    first.cancel()
    await api.release()
    let cancelled = await first.value

    XCTAssertEqual(cancelled, .failed)
    let next = await syncer.sync(force: true)
    XCTAssertEqual(next, .synced)
  }

  func testEnablingWithDeniedAccessRevertsTheToggleAndWritesNothing() async {
    let api = FakeBusyBlocksAPI(enabled: false)
    let reader = FakeReader(access: .notDetermined, grants: false)
    let model = BusyBlockBriefViewModel(api: api, reader: reader)
    await model.load()

    await model.setEnabled(true)

    XCTAssertFalse(model.isEnabled)
    XCTAssertTrue(model.isAccessDenied)
    XCTAssertEqual(reader.requested, 1)
    let saves = await api.saves
    XCTAssertTrue(saves.isEmpty)
  }

  func testCancelledSaveRollsTheToggleBackWithoutAnError() async {
    let api = FakeBusyBlocksAPI(enabled: false)
    let model = BusyBlockBriefViewModel(api: api, reader: FakeReader(access: .authorized))
    await model.load()
    await api.failSave(with: CancellationError())

    await model.setEnabled(true)

    XCTAssertFalse(model.isEnabled)
    XCTAssertFalse(model.isSaving)
    XCTAssertNil(model.errorMessage)
  }

  func testEnablingWithAccessSendsCurrentBlocksAndDisablingClearsThem() async {
    let api = FakeBusyBlocksAPI(enabled: false)
    let reader = FakeReader(access: .notDetermined, events: events())
    let syncer = BusyBlockSyncer(api: api, reader: reader, now: { [now] in now })
    let model = BusyBlockBriefViewModel(api: api, reader: reader, syncer: syncer)
    await model.load()

    await model.setEnabled(true)
    XCTAssertTrue(model.isEnabled)
    XCTAssertEqual(syncer.lastOutcome, .synced)
    await model.setEnabled(false)
    XCTAssertEqual(syncer.lastOutcome, .skipped(.disabled))

    XCTAssertFalse(model.isEnabled)
    let saves = await api.saves
    XCTAssertEqual(saves.map(\.enabled), [true, false])
    XCTAssertEqual(saves.first?.blocks.count, 1)
    XCTAssertEqual(saves.last?.blocks, [])
  }
}
