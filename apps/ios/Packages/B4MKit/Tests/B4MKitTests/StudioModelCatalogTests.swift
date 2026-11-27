import XCTest

@testable import B4MKit

private actor ListRecorder {
  private(set) var calls: [GenerationKind] = []
  private var lists: [GenerationKind: [GenerationModel]] = [:]
  private var failure: (any Error)?
  private var gate: CheckedContinuation<Void, Never>?
  private var isGated = false

  func setList(_ list: [GenerationModel], for kind: GenerationKind) { lists[kind] = list }
  func failFetches(with error: (any Error)?) { failure = error }
  func holdFetches() { isGated = true }

  func releaseFetches() {
    isGated = false
    gate?.resume()
    gate = nil
  }

  func fetch(_ kind: GenerationKind) async throws -> [GenerationModel] {
    calls.append(kind)
    let result = lists[kind] ?? []
    if isGated { await withCheckedContinuation { gate = $0 } }
    if let failure { throw failure }
    return result
  }
}

private final class Clock: @unchecked Sendable {
  private let lock = NSLock()
  private var current = Date(timeIntervalSince1970: 1_000_000)
  var now: Date { lock.withLock { current } }
  func advance(_ seconds: TimeInterval) { lock.withLock { current = current.addingTimeInterval(seconds) } }
}

@MainActor
private final class Session {
  var userID: String?
  var environment = ServerEnvironment.production
  init(_ userID: String?) { self.userID = userID }
}

@MainActor
final class StudioModelCatalogTests: XCTestCase {
  private let flux = GenerationModel(id: "flux", name: "Flux")
  private let veo = GenerationModel(id: "veo", name: "Veo")
  private let clock = Clock()
  private let recorder = ListRecorder()
  private let session = Session("u1")

  private func makeCatalog(maxAge: TimeInterval = 60) -> StudioModelCatalog {
    let session = session
    let recorder = recorder
    let clock = clock
    return StudioModelCatalog(
      maxAge: maxAge, now: { clock.now },
      currentEnvironment: { session.environment },
      resolveUserID: { session.userID },
      fetch: { try await recorder.fetch($0) })
  }

  func testAFreshListIsServedWithoutAnotherFetch() async {
    await recorder.setList([flux], for: .image)
    let catalog = makeCatalog()

    await catalog.refresh(.image)
    clock.advance(59)
    await catalog.refresh(.image)

    XCTAssertEqual(catalog.models(for: .image), [flux])
    let calls = await recorder.calls
    XCTAssertEqual(calls, [.image])
  }

  func testAStaleListIsRefetchedAndReplaced() async {
    await recorder.setList([flux], for: .image)
    let catalog = makeCatalog()
    await catalog.refresh(.image)

    await recorder.setList([flux, veo], for: .image)
    clock.advance(61)
    await catalog.refresh(.image)

    XCTAssertEqual(catalog.models(for: .image), [flux, veo])
    let calls = await recorder.calls
    XCTAssertEqual(calls, [.image, .image])
  }

  func testEachKindHasItsOwnFreshness() async {
    await recorder.setList([flux], for: .image)
    await recorder.setList([veo], for: .video)
    let catalog = makeCatalog()

    await catalog.refresh(.image)
    await catalog.refresh(.video)

    XCTAssertEqual(catalog.models(for: .image), [flux])
    XCTAssertEqual(catalog.models(for: .video), [veo])
    XCTAssertNil(catalog.models(for: .music))
  }

  func testAFailedOrEmptyLoadStoresNothingSoTheNextOpenRetries() async {
    let catalog = makeCatalog()
    await recorder.failFetches(with: APIError.malformedResponse)
    await catalog.refresh(.image)
    XCTAssertNil(catalog.models(for: .image))

    await recorder.failFetches(with: nil)
    await catalog.refresh(.image)
    XCTAssertNil(catalog.models(for: .image), "an empty list is not cached")

    await recorder.setList([flux], for: .image)
    await catalog.refresh(.image)
    XCTAssertEqual(catalog.models(for: .image), [flux])
    let calls = await recorder.calls
    XCTAssertEqual(calls.count, 3)
  }

  func testAFailedRefreshKeepsTheStaleList() async {
    await recorder.setList([flux], for: .image)
    let catalog = makeCatalog()
    await catalog.refresh(.image)

    await recorder.failFetches(with: APIError.malformedResponse)
    clock.advance(61)
    await catalog.refresh(.image)

    XCTAssertEqual(catalog.models(for: .image), [flux])
  }

  func testConcurrentRefreshesShareOneRequest() async {
    await recorder.setList([flux], for: .image)
    await recorder.holdFetches()
    let catalog = makeCatalog()

    async let first: Void = catalog.refresh(.image)
    async let second: Void = catalog.refresh(.image)
    try? await Task.sleep(for: .milliseconds(50))
    await recorder.releaseFetches()
    _ = await (first, second)

    let calls = await recorder.calls
    XCTAssertEqual(calls, [.image])
  }

  func testAnotherUserNeverSeesTheFirstUsersLists() async {
    await recorder.setList([flux], for: .image)
    let catalog = makeCatalog()
    await catalog.refresh(.image)

    session.userID = "u2"
    await recorder.setList([veo], for: .image)
    await catalog.refresh(.image)

    XCTAssertEqual(catalog.models(for: .image), [veo])
    let calls = await recorder.calls
    XCTAssertEqual(calls.count, 2, "a different account refetches even within the TTL")
  }

  func testAServerSwitchHidesTheOldServersLists() async {
    await recorder.setList([flux], for: .image)
    let catalog = makeCatalog()
    await catalog.refresh(.image)

    session.environment = .custom(URL(string: "https://staging.example.com")!)

    XCTAssertNil(catalog.models(for: .image))
  }

  func testInvalidateDropsTheListsAndAnInFlightFetchCannotRestoreThem() async {
    await recorder.setList([flux], for: .image)
    await recorder.holdFetches()
    let catalog = makeCatalog()

    let running = Task { await catalog.refresh(.image) }
    try? await Task.sleep(for: .milliseconds(50))
    catalog.invalidate()
    await recorder.releaseFetches()
    await running.value

    XCTAssertNil(catalog.models(for: .image))
  }

  func testNoSignedInUserFetchesNothing() async {
    session.userID = nil
    let catalog = makeCatalog()

    await catalog.refresh(.image)

    let calls = await recorder.calls
    XCTAssertTrue(calls.isEmpty)
  }

  func testACreateViewModelRendersTheCatalogListsOnItsFirstFrameAndDoesNotRefetch() async {
    let api = FakeStudioAPI()
    await api.setModels(.image, [flux])
    let catalog = makeCatalog()
    await recorder.setList([flux], for: .image)
    await catalog.refresh(.image)
    let tracker = GenerationTracker(
      api: api, realtime: nil, store: MemoryGenerationStore(), sleep: { _ in try await Task.sleep(for: .seconds(3600)) }
    )

    let reopened = StudioCreateViewModel(api: api, tracker: tracker, catalog: catalog)
    XCTAssertEqual(reopened.availableModels, [flux], "no task has run yet")
    await reopened.loadModels()

    let calls = await recorder.calls
    XCTAssertEqual(calls, [.image], "reopening within the TTL does not fetch")
    XCTAssertEqual(reopened.availableModels, [flux])
  }

  func testWithoutACatalogEntryTheViewModelFallsBackButDoesNotCacheIt() async {
    let api = FakeStudioAPI()
    let catalog = makeCatalog()
    await recorder.failFetches(with: APIError.malformedResponse)
    let tracker = GenerationTracker(
      api: api, realtime: nil, store: MemoryGenerationStore(), sleep: { _ in try await Task.sleep(for: .seconds(3600)) }
    )
    let model = StudioCreateViewModel(api: api, tracker: tracker, catalog: catalog)

    await model.loadModels()

    XCTAssertEqual(model.availableModels.map(\.id), ["gpt-image-2"])
    XCTAssertNil(catalog.models(for: .image))
  }
}
