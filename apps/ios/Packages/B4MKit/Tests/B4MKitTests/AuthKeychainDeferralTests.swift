import Security
import XCTest

@testable import B4MKit

/// A token store whose reads fail with a scripted Keychain status until cleared.
private final class LockedKeychainStore: TokenStore, @unchecked Sendable {
  private let lock = NSLock()
  private var failure: OSStatus?
  private var token: String?

  init(token: String?, failure: OSStatus?) {
    self.token = token
    self.failure = failure
  }

  func unlock() { lock.withLock { failure = nil } }

  func refreshToken() throws -> String? {
    try lock.withLock {
      if let failure { throw KeychainError(status: failure) }
      return token
    }
  }

  func setRefreshToken(_ token: String?) throws {
    lock.withLock { self.token = token }
  }
}

@MainActor
final class AuthKeychainDeferralTests: XCTestCase {
  private let clock = TestClock()

  private func makeController(_ store: any TokenStore, transport: FakeTransport = FakeTransport()) -> AuthController {
    AuthController(
      environment: .production, tokenStore: store, transport: transport,
      biometricGate: FakeBiometricGate(succeeds: true), preferences: Fixtures.isolatedDefaults(),
      deviceName: { nil }, now: clock.provider)
  }

  func testALockedKeychainAtLaunchIsNotASignOut() async throws {
    let store = LockedKeychainStore(token: "sid.0", failure: errSecInteractionNotAllowed)
    let auth = makeController(store)

    auth.restore()
    XCTAssertEqual(auth.state, .restoring, "before first unlock the session is unknown, not gone")

    do {
      _ = try await auth.accessToken()
      XCTFail("expected the Keychain error")
    } catch let error as KeychainError {
      XCTAssertTrue(error.isTransient)
    }
    store.unlock()
    XCTAssertEqual(try store.refreshToken(), "sid.0", "the stored session was not wiped")
  }

  func testRestoreSucceedsOnceTheKeychainIsReadable() {
    let store = LockedKeychainStore(token: "sid.0", failure: errSecInteractionNotAllowed)
    let auth = makeController(store)
    auth.restore()
    XCTAssertEqual(auth.state, .restoring)

    store.unlock()
    auth.restore()
    XCTAssertEqual(auth.state, .signedIn)
  }

  func testAPermanentKeychainFailureStillSignsOut() {
    let store = LockedKeychainStore(token: "sid.0", failure: errSecDecode)
    let auth = makeController(store)
    auth.restore()
    XCTAssertEqual(auth.state, .signedOut(nil))
  }

  func testATransientKeychainErrorIsARetryableAPIError() {
    XCTAssertEqual(APIError(KeychainError(status: errSecInteractionNotAllowed)), .offline)
    XCTAssertTrue(APIError(KeychainError(status: errSecInteractionNotAllowed)).isRetryable)
  }

  func testInvalidatingAStaleTokenKeepsTheCurrentOne() async throws {
    let transport = FakeTransport()
    let clock = self.clock
    let counter = Locked(0)
    await transport.respond(with: { _ in
      let next = counter.mutate { value -> Int in
        value += 1
        return value
      }
      return (
        200,
        Fixtures.json([
          "accessToken": Fixtures.jwt(expiresAt: clock.now.addingTimeInterval(1800 + Double(next))),
          "refreshToken": "sid.\(next)",
        ])
      )
    })
    let auth = makeController(InMemoryTokenStore(refreshToken: "sid.0"), transport: transport)
    auth.restore()

    let first = try await auth.accessToken()
    auth.invalidateAccessToken(first)
    let second = try await auth.accessToken()
    XCTAssertNotEqual(first, second)

    // A late 401 for the first token must not throw away the refreshed one.
    auth.invalidateAccessToken(first)
    let third = try await auth.accessToken()
    XCTAssertEqual(third, second)
    XCTAssertEqual(counter.current, 2, "one refresh per rejected token, none for a stale rejection")
  }
}
