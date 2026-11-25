import XCTest

@testable import B4MKit

private actor FakeBusyBlocksAPI: BusyBlocksAPI {
  var stored: BusyBlocksState
  private(set) var saves: [(enabled: Bool, blocks: [BusyBlock])] = []
  private(set) var reads = 0

  init(enabled: Bool) { stored = BusyBlocksState(enabled: enabled, blocks: []) }

  func state() async throws -> BusyBlocksState {
    reads += 1
    return stored
  }

  func save(enabled: Bool, blocks: [BusyBlock]) async throws -> BusyBlocksState {
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
