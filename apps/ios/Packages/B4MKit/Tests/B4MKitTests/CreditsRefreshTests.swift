import XCTest

@testable import B4MKit

@MainActor
final class CreditsRefreshTests: XCTestCase {
  func testSettingsReusesSettledTurnBalanceAndWidgetSnapshot() async {
    let store = InMemoryWidgetSnapshotStore()
    let recorder = WidgetSnapshotRecorder(store: store, reloader: NoopWidgetTimelineReloader())
    var calls = 0
    let model = CreditsViewModel(
      fetch: {
        calls += 1
        return CreditBalance(credits: calls == 1 ? 100 : 90)
      }, onBalance: { await recorder.recordCredits($0) })

    await model.load()
    await model.load(force: true)
    await model.load()

    XCTAssertEqual(calls, 2)
    XCTAssertEqual(model.balance?.credits, 90)
    XCTAssertEqual(store.load()?.credits?.balance, model.balance?.credits)
  }

  func testSettingsRefreshesAtTTL() async {
    var now = Samples.date
    var calls = 0
    let model = CreditsViewModel(
      now: { now },
      fetch: {
        calls += 1
        return CreditBalance(credits: Double(calls))
      })
    await model.load()
    now = now.addingTimeInterval(29)
    await model.load()
    XCTAssertEqual(calls, 1)
    now = now.addingTimeInterval(1)
    await model.load()
    XCTAssertEqual(calls, 2)
  }

  func testSettingsJoinsInFlightRefresh() async {
    let fetcher = SuspendedBalance()
    let model = CreditsViewModel(fetch: { try await fetcher.fetch() })
    let refresh = Task { await model.load(force: true) }
    await fetcher.waitForRequest()
    let settings = Task { await model.load() }
    await Task.yield()
    fetcher.finish(90)
    await refresh.value
    await settings.value
    XCTAssertEqual(fetcher.calls, 1)
    XCTAssertEqual(model.balance?.credits, 90)
  }

  func testInvalidationDiscardsLateBalanceAndWidgetWrite() async {
    let fetcher = SuspendedBalance()
    let store = InMemoryWidgetSnapshotStore()
    let recorder = WidgetSnapshotRecorder(store: store, reloader: NoopWidgetTimelineReloader())
    let model = CreditsViewModel(
      fetch: { try await fetcher.fetch() }, onBalance: { await recorder.recordCredits($0) })
    let refresh = Task { await model.load() }
    await fetcher.waitForRequest()
    model.invalidate()
    fetcher.finish(100)
    await refresh.value
    XCTAssertNil(model.balance)
    XCTAssertEqual(model.state, .idle)
    XCTAssertNil(store.load()?.credits)

    let nextAccount = Task { await model.load() }
    await fetcher.waitForRequest()
    fetcher.finish(7)
    await nextAccount.value
    XCTAssertEqual(model.balance?.credits, 7)
    XCTAssertEqual(store.load()?.credits?.balance, 7)
  }

  func testForcedRefreshSupersedesPreSettlementRequest() async {
    let fetcher = SuspendedBalance()
    let model = CreditsViewModel(fetch: { try await fetcher.fetch() })
    let old = Task { await model.load() }
    await fetcher.waitForRequest()
    let oldResponse = fetcher.takeResponse()
    let settled = Task { await model.load(force: true) }
    await fetcher.waitForRequest()
    fetcher.finish(90)
    await settled.value
    oldResponse.resume(returning: CreditBalance(credits: 100))
    await old.value
    XCTAssertEqual(fetcher.calls, 2)
    XCTAssertEqual(model.balance?.credits, 90)
  }

  func testInvalidationClearsFreshBalanceAndFailureCanRetry() async {
    var calls = 0
    let model = CreditsViewModel(fetch: {
      calls += 1
      if calls == 2 { throw APIError.offline }
      return CreditBalance(credits: Double(calls))
    })
    await model.load()
    model.invalidate()
    XCTAssertNil(model.balance)
    await model.load()
    XCTAssertEqual(model.state, .failed(.offline))
    await model.load()
    XCTAssertEqual(calls, 3)
    XCTAssertEqual(model.balance?.credits, 3)
  }
}

@MainActor
private final class SuspendedBalance {
  private(set) var calls = 0
  private var response: CheckedContinuation<CreditBalance, Never>?
  private var started: CheckedContinuation<Void, Never>?

  func fetch() async throws -> CreditBalance {
    calls += 1
    return await withCheckedContinuation {
      response = $0
      started?.resume()
      started = nil
    }
  }

  func waitForRequest() async {
    if response != nil { return }
    await withCheckedContinuation { started = $0 }
  }

  func takeResponse() -> CheckedContinuation<CreditBalance, Never> {
    let pending = response!
    response = nil
    return pending
  }

  func finish(_ credits: Double) {
    takeResponse().resume(returning: CreditBalance(credits: credits))
  }
}
