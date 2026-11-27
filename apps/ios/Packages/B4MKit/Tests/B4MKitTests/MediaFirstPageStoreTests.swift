import XCTest

@testable import B4MKit

private func item(_ id: String, kind: MediaKind = .image) -> MediaItem {
  MediaItem(
    id: id, kind: kind, fileName: "\(id).png", mimeType: "\(kind.rawValue)/x",
    createdAt: Date(timeIntervalSince1970: 1_700_000_000), url: URL(string: "https://s3.example/\(id)"),
    sessionID: "s-\(id)", prompt: "p-\(id)")
}

final class FileMediaListCacheTests: XCTestCase {
  private var directory: URL!

  override func setUp() {
    directory = FileManager.default.temporaryDirectory.appending(path: "b4m-media-cache-\(UUID().uuidString)")
  }

  override func tearDown() {
    try? FileManager.default.removeItem(at: directory)
  }

  func testRoundTripKeepsEveryFieldAndIsPerKind() async {
    let cache = FileMediaListCache(directory: directory, environment: .production)
    let empty = await cache.load(kind: nil)
    XCTAssertNil(empty)

    let page = MediaPage(items: [item("a"), item("b", kind: .video)], hasMore: true)
    await cache.save(page, kind: nil)
    let reopened = FileMediaListCache(directory: directory, environment: .production)
    let loaded = await reopened.load(kind: nil)
    XCTAssertEqual(loaded, page)
    let otherKind = await reopened.load(kind: .video)
    XCTAssertNil(otherKind)
  }

  func testServersDoNotShareACache() async {
    let production = FileMediaListCache(directory: directory, environment: .production)
    let staging = FileMediaListCache(
      directory: directory, environment: .custom(URL(string: "https://staging.example.test")!))
    await production.save(MediaPage(items: [item("prod")], hasMore: false), kind: nil)
    let stagingPage = await staging.load(kind: nil)
    XCTAssertNil(stagingPage)
  }

  func testClearRemovesEveryKind() async {
    let cache = FileMediaListCache(directory: directory, environment: .production)
    let page = MediaPage(items: [item("a")], hasMore: false)
    await cache.save(page, kind: nil)
    await cache.save(page, kind: .image)
    await cache.clear()
    let all = await cache.load(kind: nil)
    let images = await cache.load(kind: .image)
    XCTAssertNil(all)
    XCTAssertNil(images)
  }

  func testCorruptFileIsDiscardedNotFatal() async throws {
    let cache = FileMediaListCache(directory: directory, environment: .production)
    await cache.save(MediaPage(items: [item("a")], hasMore: false), kind: nil)
    let file = try XCTUnwrap(
      FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).first)
    try Data("not json".utf8).write(to: file)

    let loaded = await cache.load(kind: nil)
    XCTAssertNil(loaded)
    XCTAssertFalse(FileManager.default.fileExists(atPath: file.path()))
  }
}

@MainActor
final class MediaFirstPageStoreTests: XCTestCase {
  func testRefreshPersistsAndAFreshStoreSeedsFromDisk() async throws {
    let api = FakeMediaAPI()
    let cache = InMemoryMediaListCache()
    await api.setPages([1: MediaPage(items: [item("a")], hasMore: true)])
    let first = MediaFirstPageStore(api: api, cache: cache)
    let coldSeed = await first.seeded(kind: nil)
    XCTAssertNil(coldSeed)
    _ = try await first.refresh(kind: nil)

    let relaunched = MediaFirstPageStore(api: api, cache: cache)
    let seeded = await relaunched.seeded(kind: nil)
    XCTAssertEqual(seeded, MediaPage(items: [item("a")], hasMore: true))
  }

  func testRefreshRequestsTheConfiguredPageSizeForPageOne() async throws {
    let api = FakeMediaAPI()
    let store = MediaFirstPageStore(api: api, pageSize: 30)
    _ = try await store.refresh(kind: .image)
    let calls = await api.listCalls
    XCTAssertEqual(calls.map(\.page), [1])
    XCTAssertEqual(calls.map(\.kind), [.image])
  }

  func testServerWinsOverTheSeed() async throws {
    let api = FakeMediaAPI()
    let cache = InMemoryMediaListCache()
    await cache.save(MediaPage(items: [item("old")], hasMore: false), kind: nil)
    await api.setPages([1: MediaPage(items: [item("new")], hasMore: false)])
    let store = MediaFirstPageStore(api: api, cache: cache)

    let seeded = await store.seeded(kind: nil)
    XCTAssertEqual(seeded?.items.map(\.id), ["old"])
    let fresh = try await store.refresh(kind: nil)
    XCTAssertEqual(fresh.items.map(\.id), ["new"])
    let afterwards = await store.seeded(kind: nil)
    XCTAssertEqual(afterwards?.items.map(\.id), ["new"])
    let onDisk = await cache.load(kind: nil)
    XCTAssertEqual(onDisk?.items.map(\.id), ["new"])
  }

  func testFailedRefreshLeavesTheSeedAlone() async {
    let api = FakeMediaAPI()
    let cache = InMemoryMediaListCache()
    await cache.save(MediaPage(items: [item("old")], hasMore: false), kind: nil)
    await api.setFailure(.offline)
    let store = MediaFirstPageStore(api: api, cache: cache)
    do {
      _ = try await store.refresh(kind: nil)
      XCTFail("expected the refresh to throw")
    } catch {
      XCTAssertEqual(error as? APIError, .offline)
    }
    let seeded = await store.seeded(kind: nil)
    XCTAssertEqual(seeded?.items.map(\.id), ["old"])
  }

  func testInvalidateForgetsMemoryAndDisk() async throws {
    let api = FakeMediaAPI()
    let cache = InMemoryMediaListCache()
    await api.setPages([1: MediaPage(items: [item("a")], hasMore: false)])
    let store = MediaFirstPageStore(api: api, cache: cache)
    _ = try await store.refresh(kind: nil)
    await store.invalidate()

    let seeded = await store.seeded(kind: nil)
    let onDisk = await cache.load(kind: nil)
    XCTAssertNil(seeded)
    XCTAssertNil(onDisk)
  }

  func testAResponseInFlightAtSignOutDoesNotRepopulate() async throws {
    let api = FakeMediaAPI()
    let cache = InMemoryMediaListCache()
    await api.setPages([1: MediaPage(items: [item("prev-account")], hasMore: false)])
    await api.hold(kind: nil)
    let store = MediaFirstPageStore(api: api, cache: cache)

    let inFlight = Task { try await store.refresh(kind: nil) }
    while await api.listCalls.isEmpty { await Task.yield() }
    await store.invalidate()
    await api.release()
    _ = try await inFlight.value

    let seeded = await store.seeded(kind: nil)
    let onDisk = await cache.load(kind: nil)
    XCTAssertNil(seeded)
    XCTAssertNil(onDisk)
  }

  func testGalleryLoadFeedsTheStoreThePickerSeedsFrom() async throws {
    let api = FakeMediaAPI()
    await api.setPages([1: MediaPage(items: [item("a"), item("b")], hasMore: false)])
    let store = MediaFirstPageStore(api: api)
    let gallery = MediaGalleryViewModel(api: api, firstPages: store)
    await gallery.load()

    let pickerSeed = await store.seeded(kind: .image)
    XCTAssertNil(pickerSeed, "the image filter has its own page 1")
    let allSeed = await store.seeded(kind: nil)
    XCTAssertEqual(allSeed?.items.map(\.id), ["a", "b"])
  }
}

@MainActor
final class MediaGalleryStaleFirstTests: XCTestCase {
  func testReopenRendersSeedBeforeTheNetworkAnswers() async {
    let api = FakeMediaAPI()
    let cache = InMemoryMediaListCache()
    await cache.save(MediaPage(items: [item("cached")], hasMore: true), kind: nil)
    await api.setPages([1: MediaPage(items: [item("fresh")], hasMore: false)])
    await api.hold(kind: nil)
    let store = MediaFirstPageStore(api: api, cache: cache)
    let model = MediaGalleryViewModel(api: api, firstPages: store)

    let loading = Task { await model.load() }
    while await api.listCalls.isEmpty { await Task.yield() }
    XCTAssertEqual(model.items.map(\.id), ["cached"])
    XCTAssertEqual(model.state, .loaded)
    XCTAssertFalse(model.canLoadMore, "paging waits for the refresh")

    await api.release()
    await loading.value
    XCTAssertEqual(model.items.map(\.id), ["fresh"])
    XCTAssertEqual(model.state, .loaded)
  }

  func testOfflineReopenKeepsTheSeedOnScreen() async {
    let api = FakeMediaAPI()
    let cache = InMemoryMediaListCache()
    await cache.save(MediaPage(items: [item("cached")], hasMore: false), kind: nil)
    await api.setFailure(.offline)
    let model = MediaGalleryViewModel(api: api, firstPages: MediaFirstPageStore(api: api, cache: cache))
    await model.load()
    XCTAssertEqual(model.items.map(\.id), ["cached"])
    XCTAssertEqual(model.state, .failed(.offline))
  }

  func testSecondGalleryOpenSeedsFromTheFirstOpen() async {
    let api = FakeMediaAPI()
    await api.setPages([1: MediaPage(items: [item("a")], hasMore: false)])
    let store = MediaFirstPageStore(api: api)
    await MediaGalleryViewModel(api: api, firstPages: store).load()

    await api.hold(kind: nil)
    let reopened = MediaGalleryViewModel(api: api, firstPages: store)
    let loading = Task { await reopened.load() }
    while await api.listCalls.count < 2 { await Task.yield() }
    XCTAssertEqual(reopened.items.map(\.id), ["a"])
    await api.release()
    await loading.value
  }
}
