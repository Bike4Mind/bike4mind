import XCTest

@testable import B4MKit

private let base = URL(string: "https://app.example.test")!

private func json(_ text: String) -> Data { Data(text.utf8) }

final class AccountClientWireTests: XCTestCase {
  // Fixtures mirror apps/client/pages/api/account/deletion.ts and the error envelope of
  // apps/client/server/middlewares/errorHandler.ts (additionalInfo spread at the top level).

  func testRequestIsABearerPostToAccountDeletion() async throws {
    let body = json(
      #"{"deletion":{"requestedAt":"2026-11-02T10:00:00.000Z","scheduledFor":"2026-12-02T10:00:00.000Z","source":"self"},"canceledSubscriptions":0}"#
    )
    let transport = FakeTransport { _ in (202, body) }
    let client = AccountClient(baseURL: base, tokens: FakeTokens(), transport: transport)

    let receipt = try await client.requestDeletion()

    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.url?.path(), "/api/account/deletion")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-1")
    XCTAssertNil(request.httpBody)
    XCTAssertEqual(receipt.scheduledFor, Date(timeIntervalSince1970: 1_796_205_600))
  }

  func testRequestSucceedsOnAnEmptyBody() async throws {
    let transport = FakeTransport { _ in (202, Data()) }
    let client = AccountClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    let receipt = try await client.requestDeletion()
    XCTAssertNil(receipt.scheduledFor)
  }

  func testRestoreIsADeleteOnAccountDeletion() async throws {
    let transport = FakeTransport { _ in (204, Data()) }
    let client = AccountClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    try await client.restoreDeletion()
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "DELETE")
    XCTAssertEqual(request.url?.path(), "/api/account/deletion")
  }

  func testRestoreWhenNothingIsScheduledCountsAsRestored() async throws {
    let transport = FakeTransport { _ in (404, json(#"{"error":"This account is not scheduled for deletion."}"#)) }
    let client = AccountClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    try await client.restoreDeletion()
  }

  func testRestoreFailureSurfacesAsAPIError() async {
    let transport = FakeTransport { _ in (409, json(#"{"error":"Account deletion has started"}"#)) }
    let client = AccountClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    do {
      try await client.restoreDeletion()
      XCTFail("expected failure")
    } catch {
      XCTAssertEqual(error as? APIError, .server(status: 409))
    }
  }

  func testConflictListsTheBlockingOrganizations() async {
    let body = json(
      """
      {"code":"ACCOUNT_DELETION_ORG_OWNER","organizations":[{"id":"org1","name":"Acme"},{"id":"org2","name":" "}],
       "error":"Transfer or delete the organizations you own before deleting your account.","request_id":"r1"}
      """)
    let transport = FakeTransport { _ in (409, body) }
    let client = AccountClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    await assertFailure(
      client,
      .organizationTransferRequired([.init(id: "org1", name: "Acme"), .init(id: "org2", name: "Untitled organization")])
    )
  }

  func testAConflictWithoutOrganizationsMeansAlreadyScheduled() async {
    let transport = FakeTransport { _ in
      (409, json(#"{"error":"This account is already scheduled for deletion.","request_id":"r1"}"#))
    }
    let client = AccountClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    await assertFailure(client, .alreadyScheduled)
  }

  func testForbiddenMeansThisSessionMayNotDelete() async {
    let transport = FakeTransport { _ in
      (403, json(#"{"error":"Account deletion cannot be requested while impersonating a user."}"#))
    }
    let client = AccountClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    await assertFailure(client, .notPermitted)
  }

  func testTheStepUpGateAsksForARecentSignIn() async {
    for code in ["step_up_required", "step_up_unavailable"] {
      let transport = FakeTransport { _ in (403, json(#"{"code":"\#(code)","error":"Recent verification required"}"#)) }
      let client = AccountClient(baseURL: base, tokens: FakeTokens(), transport: transport)
      await assertFailure(client, .recentSignInRequired)
    }
  }

  func testOfflineSurfacesAsAPIFailure() async {
    let transport = FakeTransport { _ in throw URLError(.notConnectedToInternet) }
    let client = AccountClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    await assertFailure(client, .api(.offline))
  }

  private func assertFailure(
    _ client: AccountClient, _ expected: AccountDeletionFailure, file: StaticString = #filePath, line: UInt = #line
  ) async {
    do {
      _ = try await client.requestDeletion()
      XCTFail("expected failure", file: file, line: line)
    } catch {
      XCTAssertEqual(error as? AccountDeletionFailure, expected, file: file, line: line)
    }
  }
}

final class AccountDeletionPendingTests: XCTestCase {
  // The 403 of packages/server-utils/src/auth/deletionPendingGate.ts through the shared error envelope.
  func testRecognizesThePendingShapeWithItsDate() {
    let body = json(
      #"{"code":"ACCOUNT_DELETION_PENDING","scheduledFor":"2026-12-02T10:00:00.000Z","error":"This account is scheduled for deletion. Cancel the deletion to use it again.","request_id":"r1"}"#
    )
    let notice = AccountDeletionPendingDetector.notice(status: 403, body: body)
    XCTAssertEqual(notice, AccountDeletionNotice(scheduledFor: Date(timeIntervalSince1970: 1_796_205_600)))
  }

  func testPendingWithoutADateStillCounts() {
    let notice = AccountDeletionPendingDetector.notice(
      status: 403, body: json(#"{"code":"ACCOUNT_DELETION_PENDING"}"#))
    XCTAssertEqual(notice, AccountDeletionNotice(scheduledFor: nil))
  }

  func testOrdinaryForbiddenBodiesAreNotPending() {
    XCTAssertNil(AccountDeletionPendingDetector.notice(status: 403, body: json(#"{"error":"nope"}"#)))
    XCTAssertNil(AccountDeletionPendingDetector.notice(status: 403, body: json(#"{"code":"step_up_required"}"#)))
    XCTAssertNil(AccountDeletionPendingDetector.notice(status: 403, body: Data()))
    XCTAssertNil(AccountDeletionPendingDetector.notice(status: 403, body: json("not json")))
  }

  func testOnlyA403IsPending() {
    let body = json(#"{"code":"ACCOUNT_DELETION_PENDING"}"#)
    XCTAssertNil(AccountDeletionPendingDetector.notice(status: 200, body: body))
    XCTAssertNil(AccountDeletionPendingDetector.notice(status: 401, body: body))
  }

  func testSignalDeliversToEveryObserver() {
    let signal = AccountDeletionSignal()
    let received = LockedBox<[AccountDeletionNotice]>([])
    signal.observe { notice in received.mutate { $0.append(notice) } }
    signal.observe { notice in received.mutate { $0.append(notice) } }
    signal.report(AccountDeletionNotice(scheduledFor: nil))
    XCTAssertEqual(received.value.count, 2)
  }

  @MainActor
  func testStatusGoesPendingAndResets() {
    let status = AccountStatus(signal: AccountDeletionSignal())
    XCTAssertFalse(status.isDeletionPending)
    let date = Date(timeIntervalSince1970: 1_800_000_000)
    status.receive(AccountDeletionNotice(scheduledFor: date))
    XCTAssertEqual(status.state, .deletionPending(scheduledFor: date))
    status.reset()
    XCTAssertEqual(status.state, .active)
  }

  @MainActor
  func testStatusIgnoresNoticesWhileSigningOutAfterDeletion() {
    let status = AccountStatus(signal: AccountDeletionSignal())
    status.beginSignOutAfterDeletion()
    status.receive(AccountDeletionNotice(scheduledFor: nil))
    XCTAssertEqual(status.state, .active)
    status.reset()
    status.receive(AccountDeletionNotice(scheduledFor: nil))
    XCTAssertTrue(status.isDeletionPending)
  }

  @MainActor
  func testStatusRoutesNoticesFromTheSignal() async {
    let signal = AccountDeletionSignal()
    let status = AccountStatus(signal: signal)
    signal.report(AccountDeletionNotice(scheduledFor: nil))
    for _ in 0..<50 where !status.isDeletionPending { await Task.yield() }
    XCTAssertTrue(status.isDeletionPending)
  }
}

private final class LockedBox<Value: Sendable>: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: Value

  init(_ value: Value) { stored = value }

  var value: Value { lock.withLock { stored } }

  func mutate(_ change: (inout Value) -> Void) { lock.withLock { change(&stored) } }
}

private actor ScriptedAccountAPI: AccountAPI {
  var deletion: Result<AccountDeletionReceipt, any Error>
  var restoration: Result<Void, any Error> = .success(())
  private(set) var deletionCalls = 0
  private(set) var restoreCalls = 0

  init(deletion: Result<AccountDeletionReceipt, any Error> = .success(AccountDeletionReceipt(scheduledFor: nil))) {
    self.deletion = deletion
  }

  func setDeletion(_ result: Result<AccountDeletionReceipt, any Error>) { deletion = result }
  func setRestoration(_ result: Result<Void, any Error>) { restoration = result }

  func requestDeletion() async throws -> AccountDeletionReceipt {
    deletionCalls += 1
    return try deletion.get()
  }

  func restoreDeletion() async throws {
    restoreCalls += 1
    try restoration.get()
  }
}

@MainActor
final class AccountDeletionViewModelTests: XCTestCase {
  private var endedSessions = 0

  private func makeModel(_ api: ScriptedAccountAPI) -> AccountDeletionViewModel {
    AccountDeletionViewModel(api: api) { [weak self] in self?.endedSessions += 1 }
  }

  func testTheButtonStaysDisabledUntilDELETEIsTyped() {
    let model = makeModel(ScriptedAccountAPI())
    XCTAssertFalse(model.canSubmit)
    model.confirmation = "delete"
    XCTAssertFalse(model.canSubmit)
    model.confirmation = "DELET"
    XCTAssertFalse(model.canSubmit)
    model.confirmation = "DELETE"
    XCTAssertTrue(model.canSubmit)
    model.confirmation = "  DELETE \n"
    XCTAssertTrue(model.canSubmit)
  }

  func testSubmitWithoutConfirmationNeverCallsTheServer() async {
    let api = ScriptedAccountAPI()
    let model = makeModel(api)
    await model.submit()
    let calls = await api.deletionCalls
    XCTAssertEqual(calls, 0)
    XCTAssertEqual(model.state, .idle)
  }

  func testSuccessSignsOutLocallyAfterTheServerAccepted() async {
    let date = Date(timeIntervalSince1970: 1_800_000_000)
    let api = ScriptedAccountAPI(deletion: .success(AccountDeletionReceipt(scheduledFor: date)))
    let model = makeModel(api)
    model.confirmation = "DELETE"
    await model.submit()
    XCTAssertEqual(model.state, .completed(scheduledFor: date))
    XCTAssertEqual(endedSessions, 1)
    XCTAssertFalse(model.canSubmit)
  }

  func testOrganizationConflictKeepsTheSessionAndListsTheOrganizations() async {
    let orgs = [AccountOrganization(id: "o1", name: "Acme")]
    let api = ScriptedAccountAPI(deletion: .failure(AccountDeletionFailure.organizationTransferRequired(orgs)))
    let model = makeModel(api)
    model.confirmation = "DELETE"
    await model.submit()
    XCTAssertEqual(model.state, .blockedByOrganizations(orgs))
    XCTAssertEqual(endedSessions, 0)
  }

  func testForbiddenAndNetworkFailuresKeepTheSessionAndAllowARetry() async {
    let api = ScriptedAccountAPI(deletion: .failure(AccountDeletionFailure.notPermitted))
    let model = makeModel(api)
    model.confirmation = "DELETE"
    await model.submit()
    XCTAssertEqual(model.state, .notPermitted)

    await api.setDeletion(.failure(AccountDeletionFailure.api(.offline)))
    XCTAssertTrue(model.canSubmit)
    await model.submit()
    XCTAssertEqual(model.state, .failed(.offline))
    XCTAssertEqual(endedSessions, 0)

    await api.setDeletion(.success(AccountDeletionReceipt(scheduledFor: nil)))
    await model.submit()
    XCTAssertEqual(model.state, .completed(scheduledFor: nil))
    XCTAssertEqual(endedSessions, 1)
  }
}

@MainActor
final class AccountRestoreViewModelTests: XCTestCase {
  func testRestoreCallsTheServerThenClearsThePendingState() async {
    let api = ScriptedAccountAPI()
    var restored = 0
    let model = AccountRestoreViewModel(api: api) { restored += 1 }
    await model.restore()
    let calls = await api.restoreCalls
    XCTAssertEqual(calls, 1)
    XCTAssertEqual(restored, 1)
    XCTAssertEqual(model.state, .idle)
  }

  func testAFailedRestoreStaysOnTheScreenWithTheError() async {
    let api = ScriptedAccountAPI()
    await api.setRestoration(.failure(APIError.offline))
    var restored = 0
    let model = AccountRestoreViewModel(api: api) { restored += 1 }
    await model.restore()
    XCTAssertEqual(model.state, .failed(.offline))
    XCTAssertEqual(restored, 0)
  }
}

@MainActor
final class SignOutReasonTests: XCTestCase {
  func testSignOutCarriesTheGivenReason() async throws {
    let auth = AuthController(
      environment: .production, tokenStore: InMemoryTokenStore(refreshToken: "r"),
      transport: FakeTransport { _ in (200, Data()) })
    auth.restore()
    await auth.signOut(reason: .accountDeletionRequested)
    XCTAssertEqual(auth.state, .signedOut(.accountDeletionRequested))
  }
}
