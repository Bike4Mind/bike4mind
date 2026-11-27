import Foundation
import Security
import XCTest

@testable import B4MKit

private actor SessionResponseGate {
  private var entered = false
  private var released = false
  private var responseWaiter: CheckedContinuation<Void, Never>?

  func pause() async {
    guard !released else { return }
    entered = true
    await withCheckedContinuation { responseWaiter = $0 }
  }

  func waitUntilEntered() async {
    let deadline = Date().addingTimeInterval(3)
    while !entered {
      guard Date() < deadline else { XCTFail("Operation never reached its controlled gate"); return }
      await Task.yield()
    }
  }

  func resume() {
    released = true
    responseWaiter?.resume()
    responseWaiter = nil
  }
}

private struct SessionCalendarReader: BusyBlockReader {
  func access() -> BusyBlockAccess { .authorized }
  func requestAccess() async -> Bool { true }
  func events(from start: Date, to end: Date) -> [CalendarEventSample] { [] }
}

private actor SessionRequestCounter {
  private var value = 0
  func next() -> Int { value += 1; return value }
}

private final class SessionPermissionReader: BusyBlockReader, @unchecked Sendable {
  private let lock = NSLock()
  private var next = 0
  private let gates: [SessionResponseGate]
  init(_ gates: [SessionResponseGate]) { self.gates = gates }
  func access() -> BusyBlockAccess { .authorized }
  func requestAccess() async -> Bool {
    let gate = lock.withLock {
      let index = next
      next += 1
      return index < gates.count ? gates[index] : nil
    }
    if let gate { await gate.pause() }
    return true
  }
  func events(from start: Date, to end: Date) -> [CalendarEventSample] { [] }
}

private struct UnreadableSessionStore: TokenStore {
  func refreshToken() throws -> String? { throw KeychainError(status: errSecInteractionNotAllowed) }
  func setRefreshToken(_ token: String?) throws { throw KeychainError(status: errSecInteractionNotAllowed) }
  func pendingRevocations() throws -> [PendingRevocation] { throw KeychainError(status: errSecInteractionNotAllowed) }
  func setPendingRevocations(_ revocations: [PendingRevocation]) throws {
    throw KeychainError(status: errSecInteractionNotAllowed)
  }
}

private final class SessionBackgroundScheduler: BackgroundRefreshScheduling, @unchecked Sendable {
  private let lock = NSLock()
  private var count = 0
  var submissions: Int { lock.withLock { count } }
  func submit(identifier: String, earliestBegin: Date) throws { lock.withLock { count += 1 } }
  func cancel(identifier: String) {}
}

@MainActor
private final class SessionBackgroundTask: BackgroundRefreshTask {
  var expirationHandler: (@Sendable () -> Void)?
  private(set) var completions: [Bool] = []
  func setTaskCompleted(success: Bool) { completions.append(success) }
  func waitForCompletion() async {
    let deadline = Date().addingTimeInterval(3)
    while completions.isEmpty {
      guard Date() < deadline else { XCTFail("Background task did not finish"); return }
      await Task.yield()
    }
  }
}

private struct SessionAuthFixture: Sendable {
  let auth: AuthController
  let transport: FakeTransport
  let tokenA: String
  let tokenB: String
  let freshToken: String
}

@MainActor
private func sessionAuthFixture(
  sameToken: Bool = false, store: any TokenStore = InMemoryTokenStore()
) -> SessionAuthFixture {
  let clock = TestClock()
  let tokenA = Fixtures.jwt(expiresAt: clock.now.addingTimeInterval(3600), subject: "account-a")
  let tokenB = sameToken ? tokenA : Fixtures.jwt(expiresAt: clock.now.addingTimeInterval(3600), subject: "account-b")
  let fresh = Fixtures.jwt(expiresAt: clock.now.addingTimeInterval(7200), subject: "account-a")
  let transport = FakeTransport { request in
    if request.url?.path == "/api/logout" { return (200, Data()) }
    if request.url?.path == "/api/auth/refreshToken" {
      return (200, Fixtures.json(["accessToken": fresh, "refreshToken": "refreshed-a"]))
    }
    let isA = Fixtures.jsonBody(of: request)["code"] as? String == "account-a"
    return (
      200,
      Fixtures.json([
        "access_token": isA ? tokenA : tokenB, "refresh_token": isA ? "refresh-a" : "refresh-b",
      ])
    )
  }
  let auth = AuthController(
    environment: .production, tokenStore: store, sessionEndCleanup: { _ in }, transport: transport,
    biometricGate: FakeBiometricGate(succeeds: true), preferences: Fixtures.isolatedDefaults(),
    deviceName: { "test" }, now: { clock.now }
  )
  return SessionAuthFixture(auth: auth, transport: transport, tokenA: tokenA, tokenB: tokenB, freshToken: fresh)
}

@MainActor
private final class CaptureCounter {
  var count = 0
}

@MainActor
private func sessionSyncer(
  _ auth: AuthController, transport: FakeTransport, reader: any BusyBlockReader = SessionCalendarReader(),
  captures: CaptureCounter? = nil
) -> BusyBlockSyncer {
  let initial = BusyBlocksClient.session(for: auth, transport: transport)
  return BusyBlockSyncer(
    api: initial.api, reader: reader,
    sessionFactory: {
      captures?.count += 1
      return BusyBlocksClient.session(for: auth, transport: transport)
    })
}

@MainActor
final class BusyBlockSessionIsolationTests: XCTestCase {
  func testRetainedSaveNeverRetriesWithTheNextAccountsToken() async throws {
    let clock = TestClock()
    let tokenA = Fixtures.jwt(expiresAt: clock.now.addingTimeInterval(3600), subject: "account-a")
    let tokenB = Fixtures.jwt(expiresAt: clock.now.addingTimeInterval(3600), subject: "account-b")
    let authTransport = FakeTransport { request in
      if request.url?.path == "/api/logout" { return (200, Data()) }
      let account = Fixtures.jsonBody(of: request)["code"] as? String
      return (
        200,
        Fixtures.json([
          "access_token": account == "account-a" ? tokenA : tokenB,
          "refresh_token": account == "account-a" ? "refresh-a" : "refresh-b",
        ])
      )
    }
    let auth = AuthController(
      environment: .production, tokenStore: InMemoryTokenStore(), sessionEndCleanup: { _ in }, transport: authTransport,
      biometricGate: FakeBiometricGate(succeeds: true), preferences: Fixtures.isolatedDefaults(),
      deviceName: { "test" }, now: { clock.now }
    )
    try await auth.signIn(using: FakeWebAuthenticator(.approve(code: "account-a")))
    let response = SessionResponseGate()
    let busyTransport = FakeTransport { request in
      if request.httpMethod == "PUT", request.value(forHTTPHeaderField: "Authorization") == "Bearer \(tokenA)" {
        await response.pause()
        return (401, Data())
      }
      return (200, Fixtures.json(["enabled": false, "blocks": [], "nextBlockBriefAt": NSNull()]))
    }
    let initial = BusyBlocksClient.session(for: auth, transport: busyTransport)
    let syncer = BusyBlockSyncer(
      api: initial.api, reader: SessionCalendarReader(),
      sessionFactory: {
        BusyBlocksClient.session(for: auth, transport: busyTransport)
      })
    let oldSave = Task { try await syncer.save(enabled: false) }
    await response.waitUntilEntered()
    await auth.signOut()
    try await auth.signIn(using: FakeWebAuthenticator(.approve(code: "account-b")))
    syncer.sessionDidStart()
    await response.resume()
    _ = await oldSave.result
    let sent = await busyTransport.requests
    XCTAssertEqual(sent.map { $0.value(forHTTPHeaderField: "Authorization") }, ["Bearer \(tokenA)"])
    XCTAssertEqual(auth.state, .signedIn)
    let currentToken = try await auth.accessToken()
    XCTAssertEqual(currentToken, tokenB)
  }

  func testSameSession401StillRefreshesAndRetries() async throws {
    let fixture = sessionAuthFixture()
    try await fixture.auth.signIn(using: FakeWebAuthenticator(.approve(code: "account-a")))
    let ticket = fixture.auth.captureSession()
    let counter = SessionRequestCounter()
    let transport = FakeTransport { _ in
      if await counter.next() == 1 { return (401, Data()) }
      return (200, Fixtures.json(["enabled": false, "blocks": [], "nextBlockBriefAt": NSNull()]))
    }
    _ = try await sessionSyncer(fixture.auth, transport: transport).save(enabled: false)
    let requests = await transport.requests
    XCTAssertEqual(
      requests.map { $0.value(forHTTPHeaderField: "Authorization") },
      [
        "Bearer \(fixture.tokenA)", "Bearer \(fixture.freshToken)",
      ])
    XCTAssertEqual(fixture.auth.captureSession(), ticket)
  }

  func testStaleCallbacksCannotEndANewSessionWithTheSameTokenString() async throws {
    let fixture = sessionAuthFixture(sameToken: true)
    try await fixture.auth.signIn(using: FakeWebAuthenticator(.approve(code: "account-a")))
    let ticket = fixture.auth.captureSession()
    let tokens = fixture.auth.scopedTokens(for: ticket)
    await fixture.auth.signOut()
    try await fixture.auth.signIn(using: FakeWebAuthenticator(.approve(code: "account-b")))
    await tokens.invalidateAccessToken(fixture.tokenA)
    await tokens.sessionRejected()
    do {
      _ = try await tokens.accessToken()
      XCTFail("A stale session must not obtain the new account's token")
    } catch { XCTAssertEqual(error as? AuthError, .signedOut) }
    XCTAssertEqual(fixture.auth.state, .signedIn)
    let current = try await fixture.auth.accessToken()
    XCTAssertEqual(current, fixture.tokenB)
    let refreshes = await fixture.transport.requests(to: "/api/auth/refreshToken")
    XCTAssertTrue(refreshes.isEmpty)
  }

  func testSecond401FromAnOldSaveCannotRejectTheNewSession() async throws {
    let fixture = sessionAuthFixture()
    try await fixture.auth.signIn(using: FakeWebAuthenticator(.approve(code: "account-a")))
    let counter = SessionRequestCounter()
    let retry = SessionResponseGate()
    let transport = FakeTransport { _ in
      if await counter.next() == 1 { return (401, Data()) }
      await retry.pause()
      return (401, Data())
    }
    let syncer = sessionSyncer(fixture.auth, transport: transport)
    let old = Task { try await syncer.save(enabled: false) }
    await retry.waitUntilEntered()
    await fixture.auth.signOut()
    try await fixture.auth.signIn(using: FakeWebAuthenticator(.approve(code: "account-b")))
    await retry.resume()
    _ = await old.result
    XCTAssertEqual(fixture.auth.state, .signedIn)
    let current = try await fixture.auth.accessToken()
    XCTAssertEqual(current, fixture.tokenB)
    let requests = await transport.requests
    XCTAssertEqual(requests.count, 2)
  }

  func testQueuedSyncAndAccountABACannotRebindAnOldAdmission() async throws {
    let fixture = sessionAuthFixture()
    try await fixture.auth.signIn(using: FakeWebAuthenticator(.approve(code: "account-a")))
    let transport = FakeTransport { _ in
      (200, Fixtures.json(["enabled": true, "blocks": [], "nextBlockBriefAt": NSNull()]))
    }
    let captures = CaptureCounter()
    let syncer = sessionSyncer(fixture.auth, transport: transport, captures: captures)
    let oldAdmission = syncer.captureAdmission()
    let capturesBeforeSchedule = captures.count
    let queued = syncer.scheduleSync()
    XCTAssertEqual(captures.count, capturesBeforeSchedule + 1, "scheduleSync must capture before its Task starts")
    await fixture.auth.signOut()
    try await fixture.auth.signIn(using: FakeWebAuthenticator(.approve(code: "account-b")))
    let queuedOutcome = await queued.value
    XCTAssertEqual(queuedOutcome, .skipped(.signedOut))
    let beforeNew = await transport.requests
    XCTAssertTrue(beforeNew.isEmpty)
    let newOutcome = await syncer.sync()
    XCTAssertEqual(newOutcome, .synced)
    await fixture.auth.signOut()
    try await fixture.auth.signIn(using: FakeWebAuthenticator(.approve(code: "account-a")))
    let beforeABA = await transport.requests.count
    let stale = await syncer.sync(admission: oldAdmission)
    XCTAssertEqual(stale, .skipped(.signedOut))
    let afterABA = await transport.requests.count
    XCTAssertEqual(afterABA, beforeABA)
  }

  func testNewSessionResetsThrottleBeforeObserverAndLateObserverIsIdempotent() async throws {
    let fixture = sessionAuthFixture()
    try await fixture.auth.signIn(using: FakeWebAuthenticator(.approve(code: "account-a")))
    let tokenB = fixture.tokenB
    let entered = SessionResponseGate()
    let transport = FakeTransport { request in
      let isB = request.value(forHTTPHeaderField: "Authorization") == "Bearer \(tokenB)"
      if isB && request.httpMethod == "GET" { await entered.pause() }
      return (200, Fixtures.json(["enabled": isB, "blocks": [], "nextBlockBriefAt": NSNull()]))
    }
    let syncer = sessionSyncer(fixture.auth, transport: transport)
    let old = await syncer.sync()
    XCTAssertEqual(old, .skipped(.disabled))
    await fixture.auth.signOut()
    try await fixture.auth.signIn(using: FakeWebAuthenticator(.approve(code: "account-b")))
    let current = Task { await syncer.sync() }
    await entered.waitUntilEntered()
    syncer.sessionDidStart()
    await entered.resume()
    let outcome = await current.value
    XCTAssertEqual(outcome, .synced)
    XCTAssertEqual(syncer.lastOutcome, .synced)
  }

  func testOldPermissionCompletionCannotSaveOrClearTheNewOwnersSavingState() async throws {
    let fixture = sessionAuthFixture()
    try await fixture.auth.signIn(using: FakeWebAuthenticator(.approve(code: "account-a")))
    let permissionA = SessionResponseGate()
    let permissionB = SessionResponseGate()
    let reader = SessionPermissionReader([permissionA, permissionB])
    let transport = FakeTransport { request in
      let enabled = request.httpMethod == "PUT" ? Fixtures.jsonBody(of: request)["enabled"] as? Bool ?? false : false
      return (200, Fixtures.json(["enabled": enabled, "blocks": [], "nextBlockBriefAt": NSNull()]))
    }
    let syncer = sessionSyncer(fixture.auth, transport: transport, reader: reader)
    let model = BusyBlockBriefViewModel(
      api: BusyBlocksClient.session(for: fixture.auth, transport: transport).api,
      reader: reader, syncer: syncer)
    await model.load()
    let old = model.scheduleSetEnabled(true)
    await permissionA.waitUntilEntered()
    await fixture.auth.signOut()
    try await fixture.auth.signIn(using: FakeWebAuthenticator(.approve(code: "account-b")))
    await model.load()
    let current = model.scheduleSetEnabled(true)
    await permissionB.waitUntilEntered()
    await permissionA.resume()
    await old.value
    XCTAssertTrue(model.isSaving)
    XCTAssertFalse(model.isEnabled)
    await permissionB.resume()
    await current.value
    XCTAssertFalse(model.isSaving)
    XCTAssertTrue(model.isEnabled)
    XCTAssertNil(model.errorMessage)
    let puts = await transport.requests.filter { $0.httpMethod == "PUT" }
    XCTAssertEqual(puts.count, 1)
    XCTAssertEqual(puts.first?.value(forHTTPHeaderField: "Authorization"), "Bearer \(fixture.tokenB)")
  }

  func testRetainedViewCannotSaveTheOldAccountsToggleIntoTheNewOne() async throws {
    let fixture = sessionAuthFixture()
    try await fixture.auth.signIn(using: FakeWebAuthenticator(.approve(code: "account-a")))
    let transport = FakeTransport { _ in
      (200, Fixtures.json(["enabled": false, "blocks": [], "nextBlockBriefAt": NSNull()]))
    }
    let syncer = sessionSyncer(fixture.auth, transport: transport)
    let model = BusyBlockBriefViewModel(
      api: BusyBlocksClient.session(for: fixture.auth, transport: transport).api,
      reader: SessionCalendarReader(), syncer: syncer)
    await model.load()
    XCTAssertTrue(model.isLoaded)
    await fixture.auth.signOut()
    try await fixture.auth.signIn(using: FakeWebAuthenticator(.approve(code: "account-b")))

    await model.setEnabled(true)

    let puts = await transport.requests.filter { $0.httpMethod == "PUT" }
    XCTAssertTrue(puts.isEmpty)
    XCTAssertFalse(model.isEnabled)
    XCTAssertFalse(model.isLoaded)
  }

  func testHeldSaveCannotMoveToAnotherServer() async throws {
    let fixture = sessionAuthFixture()
    try await fixture.auth.signIn(using: FakeWebAuthenticator(.approve(code: "account-a")))
    let tokenA = fixture.tokenA
    let response = SessionResponseGate()
    let transport = FakeTransport { request in
      if request.httpMethod == "PUT", request.value(forHTTPHeaderField: "Authorization") == "Bearer \(tokenA)" {
        await response.pause()
        return (401, Data())
      }
      return (200, Fixtures.json(["enabled": true, "blocks": [], "nextBlockBriefAt": NSNull()]))
    }
    let syncer = sessionSyncer(fixture.auth, transport: transport)
    let old = Task { try await syncer.save(enabled: false) }
    await response.waitUntilEntered()
    await fixture.auth.switchEnvironment(to: .custom(URL(string: "https://other.example.test")!))
    try await fixture.auth.signIn(using: FakeWebAuthenticator(.approve(code: "account-b")))
    await response.resume()
    _ = await old.result
    let previous = await transport.requests
    XCTAssertEqual(previous.count, 1)
    let outcome = await syncer.sync()
    XCTAssertEqual(outcome, .synced)
    let current = await transport.requests.dropFirst()
    XCTAssertEqual(current.map { $0.url?.host }, ["other.example.test", "other.example.test"])
  }

  func testColdBackgroundRestoreKeepsItsSessionAndCanSync() async throws {
    let fixture = sessionAuthFixture(store: InMemoryTokenStore(refreshToken: "refresh-a"))
    let transport = FakeTransport { _ in
      (200, Fixtures.json(["enabled": true, "blocks": [], "nextBlockBriefAt": NSNull()]))
    }
    XCTAssertEqual(fixture.auth.state, .restoring)
    let outcome = await sessionSyncer(fixture.auth, transport: transport).syncJoiningInFlight()
    XCTAssertEqual(outcome, .synced)
    XCTAssertEqual(fixture.auth.state, .signedIn)
  }

  func testUnreadableColdKeychainStaysRetryable() async {
    let fixture = sessionAuthFixture(store: UnreadableSessionStore())
    let transport = FakeTransport()
    let outcome = await sessionSyncer(fixture.auth, transport: transport).syncJoiningInFlight()
    XCTAssertEqual(outcome, .failed)
    XCTAssertEqual(fixture.auth.state, .restoring)
    XCTAssertEqual(BusyBlockBackgroundRefresh.delay(after: outcome), BusyBlockBackgroundRefresh.interval)
    let requests = await transport.requests
    XCTAssertTrue(requests.isEmpty)
  }

  func testBackgroundAdmissionIsCapturedBeforeItsTaskStarts() async throws {
    let fixture = sessionAuthFixture()
    try await fixture.auth.signIn(using: FakeWebAuthenticator(.approve(code: "account-a")))
    let transport = FakeTransport { _ in
      (200, Fixtures.json(["enabled": true, "blocks": [], "nextBlockBriefAt": NSNull()]))
    }
    let captures = CaptureCounter()
    let syncer = sessionSyncer(fixture.auth, transport: transport, captures: captures)
    let scheduler = SessionBackgroundScheduler()
    let refresh = BusyBlockBackgroundRefresh(
      identifier: "app.test.refresh", scheduler: scheduler,
      prepareSync: {
        let admission = syncer.captureAdmission()
        return { await syncer.syncJoiningInFlight(admission: admission) }
      })
    let old = SessionBackgroundTask()
    refresh.handle(old)
    XCTAssertEqual(captures.count, 1, "handle must capture the admission before its Task starts")
    await fixture.auth.signOut()
    try await fixture.auth.signIn(using: FakeWebAuthenticator(.approve(code: "account-b")))
    await old.waitForCompletion()
    let previousRequests = await transport.requests
    XCTAssertTrue(previousRequests.isEmpty)
    XCTAssertEqual(old.completions, [true])
    XCTAssertEqual(scheduler.submissions, 0)
    let current = SessionBackgroundTask()
    refresh.handle(current)
    await current.waitForCompletion()
    let currentRequests = await transport.requests
    XCTAssertEqual(currentRequests.count, 2)
    XCTAssertEqual(current.completions, [true])
    XCTAssertEqual(scheduler.submissions, 1)
  }

}
