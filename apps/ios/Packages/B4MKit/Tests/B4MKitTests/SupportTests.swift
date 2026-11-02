import XCTest

@testable import B4MKit

final class FileSessionListCacheTests: XCTestCase {
  private var directory: URL!

  override func setUp() {
    directory = FileManager.default.temporaryDirectory.appending(path: "b4m-cache-\(UUID().uuidString)")
  }

  override func tearDown() {
    try? FileManager.default.removeItem(at: directory)
  }

  func testRoundTripAndClear() async throws {
    let cache = FileSessionListCache(directory: directory, environment: .production)
    let initial = await cache.load()
    XCTAssertNil(initial)

    await cache.save([Samples.session("a"), Samples.session("b")])
    let reopened = FileSessionListCache(directory: directory, environment: .production)
    let loaded = await reopened.load()
    XCTAssertEqual(loaded, [Samples.session("a"), Samples.session("b")])

    await reopened.clear()
    let afterClear = await reopened.load()
    XCTAssertNil(afterClear)
  }

  func testServersDoNotShareACache() async throws {
    let production = FileSessionListCache(directory: directory, environment: .production)
    let staging = FileSessionListCache(
      directory: directory, environment: .custom(URL(string: "https://staging.example.test")!))
    await production.save([Samples.session("prod")])
    let stagingRows = await staging.load()
    XCTAssertNil(stagingRows)
  }

  func testCorruptFileIsDiscardedNotFatal() async throws {
    let cache = FileSessionListCache(directory: directory, environment: .production)
    await cache.save([Samples.session("a")])
    let file = try XCTUnwrap(
      FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).first)
    try Data("not json".utf8).write(to: file)

    let loaded = await cache.load()
    XCTAssertNil(loaded)
    XCTAssertFalse(FileManager.default.fileExists(atPath: file.path()))
  }
}

final class MarkdownTextTests: XCTestCase {
  func testInlineStylingIsParsed() {
    let attributed = MarkdownText.attributed("Hi **there** and `code`")
    XCTAssertEqual(String(attributed.characters), "Hi there and code")
    XCTAssertTrue(attributed.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
    XCTAssertTrue(attributed.runs.contains { $0.inlinePresentationIntent?.contains(.code) == true })
  }

  func testLineBreaksSurvive() {
    XCTAssertEqual(String(MarkdownText.attributed("one\ntwo").characters), "one\ntwo")
  }

  func testPlainTextPassesThrough() {
    XCTAssertEqual(String(MarkdownText.attributed("just text").characters), "just text")
  }
}

final class RelativeTimeTests: XCTestCase {
  private let locale = Locale(identifier: "en_US")

  func testRecentReadsJustNow() {
    XCTAssertEqual(
      RelativeTime.describe(Samples.date, now: Samples.date.addingTimeInterval(10), locale: locale), "Just now")
  }

  func testHoursAndDays() {
    XCTAssertEqual(
      RelativeTime.describe(Samples.date, now: Samples.date.addingTimeInterval(2 * 3600), locale: locale),
      "2 hours ago")
    XCTAssertEqual(
      RelativeTime.describe(Samples.date, now: Samples.date.addingTimeInterval(86_400 + 3600), locale: locale),
      "yesterday")
  }
}

@MainActor
final class CreditsViewModelTests: XCTestCase {
  func testLoadsBalance() async {
    let api = FakeAPI()
    await api.setBalance(CreditBalance(credits: 31667))
    let model = CreditsViewModel(api: api)
    await model.load()
    XCTAssertEqual(model.balance?.credits, 31667)
    XCTAssertEqual(model.state, .loaded)
  }

  func testFailureKeepsThePreviousBalance() async {
    let api = FakeAPI()
    await api.setBalance(CreditBalance(credits: 5))
    let model = CreditsViewModel(api: api)
    await model.load()
    await api.setFailure(.offline)
    await model.load()
    XCTAssertEqual(model.balance?.credits, 5)
    XCTAssertEqual(model.state, .failed(.offline))
  }

  func testFormattingGroupsThousands() {
    XCTAssertEqual(CreditsViewModel.formatted(31667, locale: Locale(identifier: "en_US")), "31,667")
    XCTAssertEqual(CreditsViewModel.formatted(12.6, locale: Locale(identifier: "en_US")), "13")
  }
}

@MainActor
final class SessionRejectedTests: XCTestCase {
  func testSessionRejectedEndsTheSessionAndWipesTheToken() async throws {
    let store = InMemoryTokenStore(refreshToken: "sid.0")
    let auth = AuthController(
      environment: .production, tokenStore: store, transport: FakeTransport(),
      biometricGate: FakeBiometricGate(succeeds: true), preferences: Fixtures.isolatedDefaults())
    auth.restore()
    XCTAssertEqual(auth.state, .signedIn)

    await auth.sessionRejected()

    XCTAssertEqual(auth.state, .signedOut(.sessionEnded))
    XCTAssertNil(try store.refreshToken())
  }
}
