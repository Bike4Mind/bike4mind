import Observation
import XCTest

@testable import B4MKit

private actor FetchRecorder {
  private(set) var calls: [AccountProfileStore.Scope] = []
  private var results: [String: AccountProfile] = [:]
  private var gates: [CheckedContinuation<Void, Never>] = []
  private var isGated = false

  func setResult(_ profile: AccountProfile?, forUser userID: String) { results[userID] = profile }
  func holdFetches() { isGated = true }

  func releaseFetches() {
    isGated = false
    let held = gates
    gates = []
    held.forEach { $0.resume() }
  }

  /// Releases one held fetch (0 = the first to start), leaving the others held.
  func releaseFetch(at index: Int) { gates.remove(at: index).resume() }

  func fetch(_ scope: AccountProfileStore.Scope) async -> AccountProfile? {
    calls.append(scope)
    let result = results[scope.userID]
    if isGated { await withCheckedContinuation { gates.append($0) } }
    return result
  }
}

private final class Flag: @unchecked Sendable {
  private let lock = NSLock()
  private var raised = false
  var value: Bool { lock.withLock { raised } }
  func raise() { lock.withLock { raised = true } }
}

private final class Clock: @unchecked Sendable {
  private let lock = NSLock()
  private var current = Date(timeIntervalSince1970: 1_000_000)
  var now: Date { lock.withLock { current } }
  func advance(_ seconds: TimeInterval) { lock.withLock { current = current.addingTimeInterval(seconds) } }
}

@MainActor
private final class Session {
  var scope: AccountProfileStore.Scope?
  init(_ scope: AccountProfileStore.Scope?) { self.scope = scope }
}

@MainActor
final class AccountProfileStoreTests: XCTestCase {
  private let production = ServerEnvironment.production
  private let alex = AccountProfile(firstName: "Alex", displayName: "Alex Rivera", email: "alex@example.com")
  private let sam = AccountProfile(firstName: "Sam", displayName: "Sam Doe", email: "sam@example.com")

  private func scope(_ userID: String, _ environment: ServerEnvironment? = nil) -> AccountProfileStore.Scope {
    .init(userID: userID, environment: environment ?? production)
  }

  private func makeStore(
    session: Session, recorder: FetchRecorder, clock: Clock = Clock(), maxAge: TimeInterval = 300
  ) -> AccountProfileStore {
    AccountProfileStore(
      maxAge: maxAge, now: { clock.now },
      resolveScope: { session.scope },
      fetch: { await recorder.fetch($0) })
  }

  func testFirstRefreshFetchesAndSecondServesTheStoredValue() async {
    let recorder = FetchRecorder()
    await recorder.setResult(alex, forUser: "u1")
    let store = makeStore(session: Session(scope("u1")), recorder: recorder)

    XCTAssertNil(store.profile(in: production))
    await store.refresh()
    XCTAssertEqual(store.profile(in: production), alex)
    await store.refresh()

    let calls = await recorder.calls
    XCTAssertEqual(calls.count, 1)
  }

  func testStoredValueIsRefetchedOnceItGoesStaleAndKeptWhenTheRefreshFails() async {
    let recorder = FetchRecorder()
    let clock = Clock()
    await recorder.setResult(alex, forUser: "u1")
    let store = makeStore(session: Session(scope("u1")), recorder: recorder, clock: clock, maxAge: 60)

    await store.refresh()
    clock.advance(30)
    await store.refresh()
    var count = await recorder.calls.count
    XCTAssertEqual(count, 1)

    await recorder.setResult(nil, forUser: "u1")
    clock.advance(31)
    await store.refresh()
    count = await recorder.calls.count
    XCTAssertEqual(count, 2)
    XCTAssertEqual(store.profile(in: production), alex, "a failed refresh must not blank a profile already shown")
  }

  func testForceRefetchesAndServerWins() async {
    let recorder = FetchRecorder()
    await recorder.setResult(alex, forUser: "u1")
    let store = makeStore(session: Session(scope("u1")), recorder: recorder)
    await store.refresh()

    let renamed = AccountProfile(firstName: "Alexis", displayName: "Alexis Rivera", email: "alex@example.com")
    await recorder.setResult(renamed, forUser: "u1")
    await store.refresh(force: true)

    XCTAssertEqual(store.profile(in: production), renamed)
  }

  func testConcurrentRefreshesShareOneRequest() async {
    let recorder = FetchRecorder()
    await recorder.setResult(alex, forUser: "u1")
    await recorder.holdFetches()
    let store = makeStore(session: Session(scope("u1")), recorder: recorder)

    async let drawer: Void = store.refresh()
    async let home: Void = store.refresh()
    await eventually { await recorder.calls.count == 1 }
    await recorder.releaseFetches()
    _ = await (drawer, home)

    let calls = await recorder.calls
    XCTAssertEqual(calls.count, 1)
    XCTAssertEqual(store.profile(in: production), alex)
  }

  func testInvalidateClearsTheStoredValue() async {
    let recorder = FetchRecorder()
    await recorder.setResult(alex, forUser: "u1")
    let store = makeStore(session: Session(scope("u1")), recorder: recorder)
    await store.refresh()

    store.invalidate()
    XCTAssertNil(store.profile(in: production))
    await store.refresh()

    let calls = await recorder.calls
    XCTAssertEqual(calls.count, 2, "after invalidation the next refresh must fetch again")
  }

  func testInvalidateDiscardsAFetchThatWasStillRunning() async {
    let recorder = FetchRecorder()
    await recorder.setResult(alex, forUser: "u1")
    await recorder.holdFetches()
    let store = makeStore(session: Session(scope("u1")), recorder: recorder)

    async let pending: Void = store.refresh()
    await eventually { await recorder.calls.count == 1 }
    store.invalidate()
    await recorder.releaseFetches()
    await pending

    XCTAssertNil(store.profile(in: production), "a sign-out must not be undone by a late response")
  }

  func testSigningIntoAnotherAccountNeverShowsThePreviousOne() async {
    let recorder = FetchRecorder()
    await recorder.setResult(alex, forUser: "u1")
    await recorder.setResult(sam, forUser: "u2")
    let session = Session(scope("u1"))
    let store = makeStore(session: session, recorder: recorder)
    await store.refresh()

    // The auth transition did not call invalidate (a path the app missed): the scope check is the backstop.
    // The first account is dropped as soon as the refresh resolves the new one, before its fetch completes.
    session.scope = scope("u2")
    await recorder.holdFetches()
    async let pending: Void = store.refresh()
    await eventually { await recorder.calls.count == 2 }
    XCTAssertNil(store.profile(in: production), "the previous account must be gone while the new one loads")
    await recorder.releaseFetches()
    await pending

    XCTAssertEqual(store.profile(in: production), sam)
  }

  func testServerSwitchHidesTheProfileFromTheOldServer() async {
    let recorder = FetchRecorder()
    await recorder.setResult(alex, forUser: "u1")
    let store = makeStore(session: Session(scope("u1")), recorder: recorder)
    await store.refresh()

    XCTAssertEqual(store.profile(in: production), alex)
    let other = ServerEnvironment.custom(URL(string: "https://staging.example.com")!)
    XCTAssertNil(store.profile(in: other))
  }

  func testNoSessionKeepsTheStoredValue() async {
    let recorder = FetchRecorder()
    await recorder.setResult(alex, forUser: "u1")
    let session = Session(scope("u1"))
    let store = makeStore(session: session, recorder: recorder)
    await store.refresh()

    session.scope = nil
    await store.refresh()

    XCTAssertEqual(
      store.profile(in: production), alex, "a transient failure to resolve the user must not blank the profile")
    store.invalidate()
    XCTAssertNil(store.profile(in: production))
  }

  func testAViewThatRenderedBeforeTheProfileLoadedIsToldWhenItLands() async {
    let recorder = FetchRecorder()
    await recorder.setResult(alex, forUser: "u1")
    let store = makeStore(session: Session(scope("u1")), recorder: recorder)

    let fired = Flag()
    withObservationTracking {
      _ = store.profile(in: production)
    } onChange: {
      fired.raise()
    }
    await store.refresh()

    XCTAssertTrue(fired.value, "a view that rendered nil must redraw once the profile is stored")
  }

  func testAFailedFirstFetchIsRetriedOnTheNextRefresh() async {
    let recorder = FetchRecorder()
    await recorder.setResult(nil, forUser: "u1")
    let store = makeStore(session: Session(scope("u1")), recorder: recorder)

    await store.refresh()
    XCTAssertNil(store.profile(in: production))

    await recorder.setResult(alex, forUser: "u1")
    await store.refresh()
    XCTAssertEqual(store.profile(in: production), alex)
    let calls = await recorder.calls
    XCTAssertEqual(calls.count, 2)
  }

  func testAnInvalidatedFetchCannotOverwriteTheFetchThatReplacedIt() async {
    let recorder = FetchRecorder()
    await recorder.setResult(alex, forUser: "u1")
    await recorder.holdFetches()
    let store = makeStore(session: Session(scope("u1")), recorder: recorder)

    async let stale: Void = store.refresh()
    await eventually { await recorder.calls.count == 1 }
    store.invalidate()
    await recorder.setResult(sam, forUser: "u1")
    async let fresh: Void = store.refresh()
    await eventually { await recorder.calls.count == 2 }

    await recorder.releaseFetch(at: 1)
    await fresh
    await recorder.releaseFetch(at: 0)
    await stale

    XCTAssertEqual(store.profile(in: production), sam, "a response from before the invalidation must not be stored")
  }
}
