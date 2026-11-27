import Foundation
import XCTest

@testable import B4MKit

private func waitForSemaphore(_ semaphore: DispatchSemaphore, timeout: DispatchTime) async -> DispatchTimeoutResult {
  await withCheckedContinuation { continuation in
    DispatchQueue.global().async { continuation.resume(returning: semaphore.wait(timeout: timeout)) }
  }
}

private struct FileLockedStore: SharedSessionStorage {
  let contents = InMemoryTokenStore(refreshToken: "opaque-refresh")
  let lockURL: URL
  func refreshToken() throws -> String? { try contents.refreshToken() }
  func setRefreshToken(_ token: String?) throws { try contents.setRefreshToken(token) }
  func pendingRevocations() throws -> [PendingRevocation] { try contents.pendingRevocations() }
  func setPendingRevocations(_ values: [PendingRevocation]) throws { try contents.setPendingRevocations(values) }
  func sharedSessionRecord() throws -> Data? { try contents.sharedSessionRecord() }
  func setSharedSessionRecord(_ data: Data?) throws { try contents.setSharedSessionRecord(data) }
  func withSharedSessionLock<Result>(_ operation: () throws -> Result) throws -> Result {
    try SharedSessionFileLock(url: lockURL).withLock(operation)
  }
}

final class SharedSessionCoordinatorTests: XCTestCase {
  private let baseURL = URL(string: "https://capture.example.test")!

  private func coordinator(_ store: InMemoryTokenStore) throws -> SharedSessionCoordinator {
    try XCTUnwrap(SharedSessionCoordinator(tokenStore: store, baseURL: baseURL))
  }

  @MainActor
  func testUnreadableLockDefersRestoreWithoutDiscardingTheSession() throws {
    let lockURL = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try Data().write(to: lockURL)
    defer { try? FileManager.default.removeItem(at: lockURL) }
    try FileManager.default.setAttributes([.posixPermissions: 0o400], ofItemAtPath: lockURL.path())
    let store = FileLockedStore(lockURL: lockURL)
    let auth = AuthController(environment: .production, tokenStore: store)
    auth.restore()
    XCTAssertEqual(auth.state, .restoring)
    XCTAssertThrowsError(try auth.captureAdmission()) { error in
      guard case SharedSessionError.unavailable = error else { return XCTFail("Expected unavailable storage") }
    }
    XCTAssertEqual(try store.refreshToken(), "opaque-refresh")
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: lockURL.path())
    auth.restore()
    XCTAssertEqual(auth.state, .signedIn)
  }

  func testFreshControllerCanAdmitAuthenticatedIdentityWithoutRefreshing() throws {
    let store = InMemoryTokenStore()
    let first = try coordinator(store)
    let signedIn = try first.establish(token: "refresh-a", userID: "account-a", replacing: nil)
    let restored = try coordinator(store)
    let snapshot = try XCTUnwrap(restored.restore())
    let admission = try restored.admission(incarnation: snapshot.record.incarnation)
    XCTAssertEqual(admission.identity.userID, "account-a")
    XCTAssertEqual(admission.identity.incarnation, signedIn.record.incarnation)
    XCTAssertNoThrow(try admission.withCurrent {})
  }

  func testLegacyRefreshOnlySessionHasNoGuessedOfflineIdentity() throws {
    let store = InMemoryTokenStore(refreshToken: "opaque-refresh")
    let session = try coordinator(store)
    let legacy = try XCTUnwrap(session.restore())
    XCTAssertThrowsError(try session.admission(incarnation: legacy.record.incarnation))
    let verified = try session.refresh(expected: legacy, token: "rotated", userID: "account-a")
    XCTAssertEqual(verified.record.incarnation, legacy.record.incarnation)
    XCTAssertEqual(try session.admission(incarnation: legacy.record.incarnation).identity.userID, "account-a")
  }

  func testStaleProducerCannotRunDestructiveAdmissionAfterAnotherSignIn() throws {
    let store = InMemoryTokenStore()
    let extensionSession = try coordinator(store)
    let a = try extensionSession.establish(token: "a", userID: "account-a", replacing: nil)
    let admission = try extensionSession.admission(incarnation: a.record.incarnation)
    let mainSession = try coordinator(store)
    let b = try mainSession.establish(token: "b", userID: "account-b", replacing: a)
    var ran = false
    XCTAssertThrowsError(try admission.withCurrent { ran = true })
    XCTAssertFalse(ran)
    XCTAssertEqual(try mainSession.current(incarnation: b.record.incarnation), b)
  }

  func testStaleRefreshOrSignOutCannotOverwriteNewSession() throws {
    let store = InMemoryTokenStore()
    let first = try coordinator(store)
    let a = try first.establish(token: "a", userID: "account-a", replacing: nil)
    let second = try coordinator(store)
    let b = try second.establish(token: "b", userID: "account-b", replacing: a)
    XCTAssertThrowsError(try first.refresh(expected: a, token: "late-a", userID: "account-a"))
    XCTAssertFalse(try first.end(incarnation: a.record.incarnation))
    XCTAssertEqual(try second.current(incarnation: b.record.incarnation), b)
  }

  func testSameAccountReauthenticationStillRejectsItsOldProducer() throws {
    let store = InMemoryTokenStore()
    let session = try coordinator(store)
    let a1 = try session.establish(token: "a1", userID: "account-a", replacing: nil)
    let admission = try session.admission(incarnation: a1.record.incarnation)
    let a2 = try session.establish(token: "a2", userID: "account-a", replacing: a1)
    XCTAssertNotEqual(a1.record.incarnation, a2.record.incarnation)
    XCTAssertThrowsError(try admission.withCurrent {})
  }

  func testSameSessionRotationPreservesAdmissionAndNeverRollsBackNewerRotation() throws {
    let store = InMemoryTokenStore()
    let session = try coordinator(store)
    let a = try session.establish(token: "a", userID: "account-a", replacing: nil)
    let admission = try session.admission(incarnation: a.record.incarnation)
    let current = try session.refresh(expected: a, token: "a-new", userID: "account-a")
    let late = try session.refresh(expected: a, token: "a-old", userID: "account-a")
    XCTAssertEqual(current, late)
    XCTAssertEqual(try store.refreshToken(), "a-new")
    XCTAssertNoThrow(try admission.withCurrent {})
  }

  func testUnpairedRawTokenDoesNotReuseThePreviousAccountIdentity() throws {
    let store = InMemoryTokenStore()
    let session = try coordinator(store)
    let a = try session.establish(token: "a", userID: "account-a", replacing: nil)
    try store.setRefreshToken("unpaired-b")
    XCTAssertThrowsError(try session.admission(incarnation: a.record.incarnation))
    let restored = try XCTUnwrap(session.restore())
    XCTAssertNil(restored.record.identity)
    XCTAssertThrowsError(try session.admission(incarnation: restored.record.incarnation))
  }

  func testStoredSessionCannotBeReboundToAnotherServerDuringRestore() throws {
    let store = InMemoryTokenStore()
    let session = try coordinator(store)
    let a = try session.establish(token: "a", userID: "account-a", replacing: nil)
    let other = try XCTUnwrap(SharedSessionCoordinator(
      tokenStore: store, baseURL: URL(string: "https://other.example.test")!))
    XCTAssertThrowsError(try other.restore())
    XCTAssertEqual(try session.current(incarnation: a.record.incarnation), a)
  }

  func testIndependentFileHandlesSerializeTheCriticalSection() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let firstLock = SharedSessionFileLock(url: directory.appending(path: "session.lock"))
    let secondLock = SharedSessionFileLock(url: directory.appending(path: "session.lock"))
    let firstEntered = DispatchSemaphore(value: 0)
    let releaseFirst = DispatchSemaphore(value: 0)
    let secondStarted = DispatchSemaphore(value: 0)
    let secondEntered = DispatchSemaphore(value: 0)
    let first = Task.detached {
      try firstLock.withLock {
        firstEntered.signal()
        _ = releaseFirst.wait(timeout: .now() + 5)
      }
    }
    let firstAcquired = await waitForSemaphore(firstEntered, timeout: .now() + 3)
    XCTAssertEqual(firstAcquired, .success)
    let second = Task.detached {
      secondStarted.signal()
      try secondLock.withLock { secondEntered.signal() }
    }
    let secondAttempted = await waitForSemaphore(secondStarted, timeout: .now() + 3)
    XCTAssertEqual(secondAttempted, .success)
    let secondBlocked = await waitForSemaphore(secondEntered, timeout: .now() + 0.1)
    XCTAssertEqual(secondBlocked, .timedOut)
    releaseFirst.signal()
    try await first.value
    _ = try await second.value
    let secondAcquired = await waitForSemaphore(secondEntered, timeout: .now() + 3)
    XCTAssertEqual(secondAcquired, .success)
  }
}
