import XCTest

@testable import B4MKit

private actor FakeBusyBlocksAPI: BusyBlocksAPI {
  var stored: BusyBlocksState
  private(set) var saves: [(enabled: Bool, blocks: [BusyBlock])] = []
  private(set) var reads = 0
  var stateError: (any Error)?
  var saveError: (any Error)?
  /// While set, `state()` suspends until `release()` so a test can overlap two syncs.
  private var gate: CheckedContinuation<Void, Never>?
  private var holdsState = false

  init(enabled: Bool) { stored = BusyBlocksState(enabled: enabled, blocks: []) }

  func failState(with error: any Error) { stateError = error }
  func failSave(with error: (any Error)?) { saveError = error }
  func holdState() { holdsState = true }
  func release() {
    holdsState = false
    gate?.resume()
    gate = nil
  }

  func state() async throws -> BusyBlocksState {
    reads += 1
    if holdsState { await withCheckedContinuation { gate = $0 } }
    if let stateError { throw stateError }
    return stored
  }

  func save(enabled: Bool, blocks: [BusyBlock]) async throws -> BusyBlocksState {
    if let saveError { throw saveError }
    saves.append((enabled, blocks))
    stored = BusyBlocksState(enabled: enabled, blocks: blocks)
    return stored
  }
}

private final class FakeReader: BusyBlockReader, @unchecked Sendable {
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
    while await api.reads == 0 { await Task.yield() }
    let second = await syncer.sync(force: true)
    await api.release()

    XCTAssertEqual(second, .skipped(.inFlight))
    let firstOutcome = await first.value
    XCTAssertEqual(firstOutcome, .synced)
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

  func testEnablingWithAccessSendsCurrentBlocksAndDisablingClearsThem() async {
    let api = FakeBusyBlocksAPI(enabled: false)
    let reader = FakeReader(access: .notDetermined, events: events())
    let model = BusyBlockBriefViewModel(
      api: api, reader: reader, syncer: BusyBlockSyncer(api: api, reader: reader, now: { [now] in now }))
    await model.load()

    await model.setEnabled(true)
    XCTAssertTrue(model.isEnabled)
    await model.setEnabled(false)

    XCTAssertFalse(model.isEnabled)
    let saves = await api.saves
    XCTAssertEqual(saves.map(\.enabled), [true, false])
    XCTAssertEqual(saves.first?.blocks.count, 1)
    XCTAssertEqual(saves.last?.blocks, [])
  }
}
