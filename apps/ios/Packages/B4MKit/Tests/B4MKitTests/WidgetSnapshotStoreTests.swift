import XCTest

@testable import B4MKit

final class WidgetSnapshotStoreTests: XCTestCase {
  private var directory: URL!

  override func setUpWithError() throws {
    directory = try temporaryDirectory()
  }

  override func tearDown() {
    try? FileManager.default.removeItem(at: directory)
  }

  private func fullSnapshot() -> WidgetSnapshot {
    WidgetSnapshot(
      runningAgents: .init(
        count: 2, top: .init(sessionID: "s1", title: "Metrics", status: "running"), observedAt: referenceDate),
      credits: .init(balance: 1234.5, observedAt: referenceDate),
      latestGeneration: .init(
        mediaID: "m1", title: "Lighthouse", createdAt: referenceDate, thumbnailFileName: "m1.img"))
  }

  func testSnapshotRoundTripsThroughTheFileStore() throws {
    let store = FileWidgetSnapshotStore(directory: directory)
    try store.save(fullSnapshot())
    XCTAssertEqual(store.load(), fullSnapshot())
  }

  func testLoadBeforeAnyWriteIsNil() {
    XCTAssertNil(FileWidgetSnapshotStore(directory: directory).load())
  }

  func testMissingContainerReadsAsEmptyAndRefusesWrites() throws {
    let store = unavailableStore()
    XCTAssertNil(store.load())
    XCTAssertThrowsError(try store.save(.empty)) { XCTAssertEqual($0 as? WidgetSnapshotError, .containerUnavailable) }
    XCTAssertThrowsError(try store.saveThumbnail(Data([1]), for: "m1")) {
      XCTAssertEqual($0 as? WidgetSnapshotError, .containerUnavailable)
    }
    XCTAssertNil(store.thumbnailURL(fileName: "m1.img"))
  }

  func testCorruptFileIsTreatedAsNoSnapshot() throws {
    try Data("not json".utf8).write(to: directory.appending(path: "snapshot.json"))
    XCTAssertNil(FileWidgetSnapshotStore(directory: directory).load())
  }

  func testASnapshotFromAnotherSchemaVersionIsIgnored() throws {
    let store = FileWidgetSnapshotStore(directory: directory)
    var future = fullSnapshot()
    future.schemaVersion = WidgetSnapshot.currentSchemaVersion + 1
    try store.save(future)
    XCTAssertNil(store.load())
  }

  func testSaveCreatesTheDirectoryOnDemand() throws {
    let nested = directory.appending(path: "a/b")
    try FileWidgetSnapshotStore(directory: nested).save(fullSnapshot())
    XCTAssertEqual(FileWidgetSnapshotStore(directory: nested).load(), fullSnapshot())
  }

  func testThumbnailIsStoredAndReplacesThePreviousOne() throws {
    let store = FileWidgetSnapshotStore(directory: directory)
    let first = try store.saveThumbnail(Data([1, 2, 3]), for: "m1")
    XCTAssertEqual(try Data(contentsOf: XCTUnwrap(store.thumbnailURL(fileName: first))), Data([1, 2, 3]))

    let second = try store.saveThumbnail(Data([9]), for: "m2")
    XCTAssertNil(store.thumbnailURL(fileName: first))
    XCTAssertEqual(try Data(contentsOf: XCTUnwrap(store.thumbnailURL(fileName: second))), Data([9]))
  }

  func testThumbnailNamesCannotEscapeTheDirectory() throws {
    let store = FileWidgetSnapshotStore(directory: directory)
    let name = try store.saveThumbnail(Data([1]), for: "../../etc/passwd")
    XCTAssertFalse(name.contains("/"))
    XCTAssertNil(store.thumbnailURL(fileName: "../snapshot.json"))
  }

  func testAppGroupFactoryDegradesWithoutTheEntitlement() {
    // A test host has no app-group entitlement, so this exercises the real "container unavailable" path.
    let store = FileWidgetSnapshotStore.appGroup(identifier: "group.invalid.\(UUID().uuidString)")
    XCTAssertNil(store.load())
  }

  func testResetRemovesTheSnapshotAndThumbnails() throws {
    let store = FileWidgetSnapshotStore(directory: directory)
    try store.save(fullSnapshot())
    let name = try store.saveThumbnail(Data([1]), for: "m1")
    store.reset()
    XCTAssertNil(store.load())
    XCTAssertNil(store.thumbnailURL(fileName: name))
    unavailableStore().reset()
  }

  func testInMemoryStoreRoundTrips() throws {
    let store = InMemoryWidgetSnapshotStore()
    XCTAssertNil(store.load())
    try store.save(fullSnapshot())
    XCTAssertEqual(store.load(), fullSnapshot())
  }
}
