import XCTest

@testable import B4MKit

@MainActor
final class AuthControllerTests: XCTestCase {
  private let refreshPath = "/api/auth/refreshToken"
  private let tokenPath = "/api/oauth/token"
  private let logoutPath = "/api/logout"

  private var clock: TestClock!
  private var store: InMemoryTokenStore!
  private var transport: FakeTransport!

  override func setUp() async throws {
    clock = TestClock()
    store = InMemoryTokenStore()
    transport = FakeTransport()
  }

  private func makeController(appLockSucceeds: Bool = true) -> AuthController {
    let clock = self.clock!
    return AuthController(
      environment: .production,
      tokenStore: store,
      transport: transport,
      biometricGate: FakeBiometricGate(succeeds: appLockSucceeds),
      preferences: Fixtures.isolatedDefaults(),
      deviceName: { "iPhone 17 Pro" },
      now: { clock.now }
    )
  }

  private func freshAccessToken() -> String {
    Fixtures.jwt(expiresAt: clock.now.addingTimeInterval(1800))
  }

  /// A responder for the refresh route that rotates `sid.N` -> `sid.N+1` and counts calls.
  private func rotatingRefreshResponder(delay: Duration = .milliseconds(50)) -> FakeTransport.Responder {
    let clock = self.clock!
    return { request in
      if request.url?.path() == "/api/logout" { return (200, Data()) }
      try await Task.sleep(for: delay)
      let presented = Fixtures.jsonBody(of: request)["token"] as? String ?? ""
      let generation = Int(presented.split(separator: ".").last ?? "0") ?? 0
      let accessToken = Fixtures.jwt(expiresAt: clock.now.addingTimeInterval(1800))
      return (200, Fixtures.json(["accessToken": accessToken, "refreshToken": "sid.\(generation + 1)"]))
    }
  }

  // MARK: - Refresh: single flight (Review Focus 1)

  func testConcurrentAccessTokenCallsShareOneRefreshRequest() async throws {
    try store.setRefreshToken("sid.0")
    await transport.respond(with: rotatingRefreshResponder())
    let auth = makeController()
    auth.restore()

    let tokens = try await withThrowingTaskGroup(of: String.self) { group in
      for _ in 0..<25 {
        group.addTask { try await auth.accessToken() }
      }
      var tokens = Set<String>()
      for try await token in group { tokens.insert(token) }
      return tokens
    }

    let refreshes = await transport.requests(to: refreshPath)
    XCTAssertEqual(refreshes.count, 1, "N concurrent callers must await one refresh")
    XCTAssertEqual(tokens.count, 1, "every caller receives the same access token")
    XCTAssertEqual(try store.refreshToken(), "sid.1")
  }

  func testRefreshRequestUsesBodyTransport() async throws {
    try store.setRefreshToken("sid.0")
    await transport.respond(with: rotatingRefreshResponder(delay: .zero))
    let auth = makeController()
    auth.restore()

    _ = try await auth.accessToken()

    let requestRequests = await transport.requests(to: refreshPath)
    let request = try XCTUnwrap(requestRequests.first)
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.url?.host(), "app.bike4mind.com")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
    XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
    XCTAssertEqual(Fixtures.jsonBody(of: request)["token"] as? String, "sid.0")
  }

  // MARK: - Refresh: rotation

  func testRefreshRotationPersistsTheNewRefreshToken() async throws {
    try store.setRefreshToken("sid.0")
    await transport.respond(with: rotatingRefreshResponder(delay: .zero))
    let auth = makeController()
    auth.restore()

    _ = try await auth.accessToken()
    XCTAssertEqual(try store.refreshToken(), "sid.1")

    clock.advance(by: 1800)  // access token expired
    _ = try await auth.accessToken()

    let presented = await transport.requests(to: refreshPath).map { Fixtures.jsonBody(of: $0)["token"] as? String }
    XCTAssertEqual(presented, ["sid.0", "sid.1"], "the second refresh must present the rotated token")
    XCTAssertEqual(try store.refreshToken(), "sid.2")
  }

  func testCachedAccessTokenIsReusedUntilItNearsExpiry() async throws {
    try store.setRefreshToken("sid.0")
    await transport.respond(with: rotatingRefreshResponder(delay: .zero))
    let auth = makeController()
    auth.restore()

    let first = try await auth.accessToken()
    clock.advance(by: 1700)
    let second = try await auth.accessToken()
    XCTAssertEqual(first, second)
    let afterOneRefresh = await transport.requests(to: refreshPath).count
    XCTAssertEqual(afterOneRefresh, 1)

    clock.advance(by: 50)  // now inside the 60s leeway
    _ = try await auth.accessToken()
    let afterTwoRefreshes = await transport.requests(to: refreshPath).count
    XCTAssertEqual(afterTwoRefreshes, 2)
  }

  func testCoalescedReplayInsideGraceWindowKeepsTheCurrentRefreshToken() async throws {
    try store.setRefreshToken("sid.0")
    let accessToken = freshAccessToken()
    await transport.respond { _ in (200, Fixtures.json(["accessToken": accessToken])) }
    let auth = makeController()
    auth.restore()

    let token = try await auth.accessToken()

    XCTAssertEqual(token, accessToken)
    XCTAssertEqual(try store.refreshToken(), "sid.0", "a coalesced response carries no refresh token; keep ours")
    XCTAssertEqual(auth.state, .signedIn)
  }

  // MARK: - Refresh: reuse rejection (Review Focus 1)

  func testReuseRejectionSignsOutWithoutLooping() async throws {
    try store.setRefreshToken("sid.0")
    await transport.respond { _ in (401, Fixtures.json(["error": "Invalid refresh token"])) }
    let auth = makeController()
    auth.restore()

    do {
      _ = try await auth.accessToken()
      XCTFail("expected refreshRejected")
    } catch {
      XCTAssertEqual(error as? AuthError, .refreshRejected)
    }

    XCTAssertEqual(auth.state, .signedOut(.sessionEnded))
    XCTAssertNil(try store.refreshToken(), "a rejected session must be wiped from the Keychain")

    // Further calls fail fast without touching the network.
    do {
      _ = try await auth.accessToken()
      XCTFail("expected signedOut")
    } catch {
      XCTAssertEqual(error as? AuthError, .signedOut)
    }
    let refreshes = await transport.requests(to: refreshPath).count
    XCTAssertEqual(refreshes, 1, "rejection is final: exactly one request, no retry loop")
  }

  func testConcurrentCallersAllSeeOneRejection() async throws {
    try store.setRefreshToken("sid.0")
    await transport.respond { _ in
      try await Task.sleep(for: .milliseconds(50))
      return (401, Data())
    }
    let auth = makeController()
    auth.restore()

    let failures = await withTaskGroup(of: AuthError?.self) { group in
      for _ in 0..<10 {
        group.addTask {
          do {
            _ = try await auth.accessToken()
            return nil
          } catch {
            return error as? AuthError
          }
        }
      }
      var failures: [AuthError?] = []
      for await failure in group { failures.append(failure) }
      return failures
    }

    XCTAssertTrue(failures.allSatisfy { $0 == .refreshRejected || $0 == .signedOut })
    let refreshes = await transport.requests(to: refreshPath).count
    XCTAssertEqual(refreshes, 1)
    XCTAssertEqual(auth.state, .signedOut(.sessionEnded))
  }

  func testRejectionRetriesOnceWhenAnotherProcessRotatedTheSharedToken() async throws {
    // The share extension rotated sid.0 -> sid.1 while our refresh of sid.0 was in flight; the server
    // rejects our stale token, and the freshly stored one must be tried exactly once.
    try store.setRefreshToken("sid.0")
    let store = self.store!
    let accessToken = freshAccessToken()
    await transport.respond { request in
      let presented = Fixtures.jsonBody(of: request)["token"] as? String
      if presented == "sid.0" {
        try store.setRefreshToken("sid.1")
        return (401, Data())
      }
      return (200, Fixtures.json(["accessToken": accessToken, "refreshToken": "sid.2"]))
    }
    let auth = makeController()
    auth.restore()

    let token = try await auth.accessToken()

    XCTAssertEqual(token, accessToken)
    XCTAssertEqual(auth.state, .signedIn)
    XCTAssertEqual(try store.refreshToken(), "sid.2")
    let presented = await transport.requests(to: refreshPath).map { Fixtures.jsonBody(of: $0)["token"] as? String }
    XCTAssertEqual(presented, ["sid.0", "sid.1"])
  }

  func testRepeatedRejectionAfterCrossProcessRetrySignsOut() async throws {
    try store.setRefreshToken("sid.0")
    let store = self.store!
    await transport.respond { request in
      if Fixtures.jsonBody(of: request)["token"] as? String == "sid.0" {
        try store.setRefreshToken("sid.1")
      }
      return (401, Data())
    }
    let auth = makeController()
    auth.restore()

    do {
      _ = try await auth.accessToken()
      XCTFail("expected refreshRejected")
    } catch {
      XCTAssertEqual(error as? AuthError, .refreshRejected)
    }
    let refreshes = await transport.requests(to: refreshPath).count
    XCTAssertEqual(refreshes, 2, "one retry with the newer token, then stop")
    XCTAssertEqual(auth.state, .signedOut(.sessionEnded))
    XCTAssertNil(try store.refreshToken())
  }

  func testRateLimitedRefreshKeepsTheSession() async throws {
    try store.setRefreshToken("sid.0")
    await transport.respond { _ in (429, Fixtures.json(["error": "slow_down"])) }
    let auth = makeController()
    auth.restore()

    do {
      _ = try await auth.accessToken()
      XCTFail("expected rateLimited")
    } catch {
      XCTAssertEqual(error as? AuthError, .rateLimited)
    }
    XCTAssertEqual(auth.state, .signedIn)
    XCTAssertEqual(try store.refreshToken(), "sid.0")
  }

  func testServerErrorDuringRefreshKeepsTheSession() async throws {
    try store.setRefreshToken("sid.0")
    await transport.respond { _ in (503, Data()) }
    let auth = makeController()
    auth.restore()

    do {
      _ = try await auth.accessToken()
      XCTFail("expected server error")
    } catch {
      XCTAssertEqual(error as? AuthError, .server(status: 503))
    }
    XCTAssertEqual(auth.state, .signedIn)
    XCTAssertEqual(try store.refreshToken(), "sid.0")
  }

  func testRefreshLandingAfterSignOutIsDiscarded() async throws {
    try store.setRefreshToken("sid.0")
    await transport.respond(with: rotatingRefreshResponder(delay: .milliseconds(100)))
    let auth = makeController()
    auth.restore()

    let pending = Task { try await auth.accessToken() }
    try await Task.sleep(for: .milliseconds(20))
    await auth.signOut()

    do {
      _ = try await pending.value
      XCTFail("expected signedOut")
    } catch {
      XCTAssertEqual(error as? AuthError, .signedOut)
    }
    XCTAssertNil(try store.refreshToken(), "a late rotation must not resurrect the wiped session")
    XCTAssertEqual(auth.state, .signedOut(.userInitiated))
  }

  // MARK: - Restore

  func testRestoreWithoutStoredTokenIsSignedOutAndNeverHitsTheNetwork() async throws {
    let auth = makeController()
    auth.restore()
    XCTAssertEqual(auth.state, .signedOut(nil))

    do {
      _ = try await auth.accessToken()
      XCTFail("expected signedOut")
    } catch {
      XCTAssertEqual(error as? AuthError, .signedOut)
    }
    let requestCount = await transport.requests.count
    XCTAssertEqual(requestCount, 0)
  }

  // MARK: - Sign in

  func testSignInExchangesCodeWithVerifierAndDeviceName() async throws {
    let accessToken = freshAccessToken()
    await transport.respond { _ in
      (
        200,
        Fixtures.json([
          "access_token": accessToken, "refresh_token": "sid.0", "token_type": "Bearer", "expires_in": 1800,
        ])
      )
    }
    let auth = makeController()
    auth.restore()
    let authenticator = FakeWebAuthenticator(.approve(code: "auth-code-1"))

    try await auth.signIn(using: authenticator)

    let requestRequests = await transport.requests(to: tokenPath)
    let request = try XCTUnwrap(requestRequests.first)
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
    let body = Fixtures.jsonBody(of: request)
    XCTAssertEqual(body["grant_type"] as? String, "authorization_code")
    XCTAssertEqual(body["code"] as? String, "auth-code-1")
    XCTAssertEqual(body["client_id"] as? String, "b4m-ios-app")
    XCTAssertEqual(body["redirect_uri"] as? String, "https://app.bike4mind.com/ios/auth-callback")
    XCTAssertEqual(body["deviceName"] as? String, "iPhone 17 Pro")

    // The verifier sent at exchange must hash to the challenge sent at authorization.
    let openedURL = try XCTUnwrap(authenticator.openedURL)
    let challenge = URLComponents(url: openedURL, resolvingAgainstBaseURL: false)?
      .queryItems?.first { $0.name == "code_challenge" }?.value
    let verifier = try XCTUnwrap(body["code_verifier"] as? String)
    XCTAssertEqual(PKCEPair(verifier: verifier).challenge, challenge)
  }

  func testSignInStoresRefreshTokenAndKeepsAccessTokenInMemory() async throws {
    let accessToken = freshAccessToken()
    await transport.respond { _ in (200, Fixtures.json(["access_token": accessToken, "refresh_token": "sid.0"])) }
    let auth = makeController()
    auth.restore()

    try await auth.signIn(using: FakeWebAuthenticator(.approve(code: "c")))

    XCTAssertEqual(auth.state, .signedIn)
    XCTAssertEqual(try store.refreshToken(), "sid.0")
    let token = try await auth.accessToken()
    XCTAssertEqual(token, accessToken)
    let refreshes = await transport.requests(to: refreshPath).count
    XCTAssertEqual(refreshes, 0, "the exchanged access token is used without an immediate refresh")
  }

  func testSignInDenialLeavesUserSignedOut() async throws {
    let auth = makeController()
    auth.restore()

    do {
      try await auth.signIn(using: FakeWebAuthenticator(.deny))
      XCTFail("expected authorizationDenied")
    } catch {
      XCTAssertEqual(error as? AuthError, .authorizationDenied)
    }
    XCTAssertEqual(auth.state, .signedOut(nil))
    let requestCount = await transport.requests.count
    XCTAssertEqual(requestCount, 0, "no code means no exchange")
  }

  func testFailedTokenExchangeSurfacesServerErrorCode() async throws {
    await transport.respond { _ in (400, Fixtures.json(["error": "invalid_grant"])) }
    let auth = makeController()
    auth.restore()

    do {
      try await auth.signIn(using: FakeWebAuthenticator(.approve(code: "c")))
      XCTFail("expected tokenExchangeFailed")
    } catch {
      XCTAssertEqual(error as? AuthError, .tokenExchangeFailed(status: 400, code: "invalid_grant"))
    }
    XCTAssertNil(try store.refreshToken())
  }

  // MARK: - Sign out

  func testSignOutRevokesServerSessionAndWipesTokens() async throws {
    let accessToken = freshAccessToken()
    await transport.respond { request in
      request.url?.path() == "/api/logout"
        ? (200, Fixtures.json(["message": "Logged out"]))
        : (200, Fixtures.json(["access_token": accessToken, "refresh_token": "sid.0"]))
    }
    let auth = makeController()
    auth.restore()
    try await auth.signIn(using: FakeWebAuthenticator(.approve(code: "c")))

    await auth.signOut()

    let logoutRequests = await transport.requests(to: logoutPath)
    let logout = try XCTUnwrap(logoutRequests.first)
    XCTAssertEqual(logout.httpMethod, "GET")
    XCTAssertEqual(logout.value(forHTTPHeaderField: "Authorization"), "Bearer \(accessToken)")
    XCTAssertEqual(auth.state, .signedOut(.userInitiated))
    XCTAssertNil(try store.refreshToken())
    do {
      _ = try await auth.accessToken()
      XCTFail("expected signedOut")
    } catch {
      XCTAssertEqual(error as? AuthError, .signedOut)
    }
  }

  func testSignOutWithoutAccessTokenMintsOneToRevokeTheSession() async throws {
    try store.setRefreshToken("sid.0")
    let accessToken = freshAccessToken()
    await transport.respond { request in
      request.url?.path() == "/api/logout"
        ? (200, Data())
        : (200, Fixtures.json(["accessToken": accessToken, "refreshToken": "sid.1"]))
    }
    let auth = makeController()
    auth.restore()

    await auth.signOut()

    let logoutRequests = await transport.requests(to: logoutPath)
    let logout = try XCTUnwrap(logoutRequests.first)
    XCTAssertEqual(logout.value(forHTTPHeaderField: "Authorization"), "Bearer \(accessToken)")
    XCTAssertNil(try store.refreshToken(), "the rotated token from the revoke path must not be stored")
  }

  func testSignOutWipesLocallyEvenWhenRevocationFails() async throws {
    let accessToken = freshAccessToken()
    await transport.respond { request in
      if request.url?.path() == "/api/logout" { throw URLError(.notConnectedToInternet) }
      return (200, Fixtures.json(["access_token": accessToken, "refresh_token": "sid.0"]))
    }
    let auth = makeController()
    auth.restore()
    try await auth.signIn(using: FakeWebAuthenticator(.approve(code: "c")))

    await auth.signOut()

    XCTAssertEqual(auth.state, .signedOut(.userInitiated))
    XCTAssertNil(try store.refreshToken())
  }

  // MARK: - Environment

  func testSwitchingEnvironmentSignsOutAndRetargetsRequests() async throws {
    try store.setRefreshToken("sid.0")
    await transport.respond(with: rotatingRefreshResponder(delay: .zero))
    let auth = makeController()
    auth.restore()

    let staging = URL(string: "https://staging.example.com")!
    await auth.switchEnvironment(to: .custom(staging))

    XCTAssertEqual(auth.environment.baseURL, staging)
    XCTAssertEqual(auth.state, .signedOut(nil))
    XCTAssertNil(try store.refreshToken())
    let hosts = await transport.requests.map { $0.url?.host() }
    XCTAssertTrue(
      hosts.allSatisfy { $0 == "app.bike4mind.com" }, "revocation goes to the server that owned the session")
  }

  // MARK: - App Lock

  func testAppLockIsOffByDefaultAndNeverLocks() async throws {
    try store.setRefreshToken("sid.0")
    let auth = makeController()
    auth.restore()

    XCTAssertFalse(auth.isAppLockEnabled)
    auth.lockIfNeeded()
    XCTAssertEqual(auth.state, .signedIn)
  }

  func testAppLockLocksAndUnlocksThroughTheBiometricGate() async throws {
    try store.setRefreshToken("sid.0")
    let auth = makeController(appLockSucceeds: true)
    auth.restore()
    auth.isAppLockEnabled = true

    auth.lockIfNeeded()
    XCTAssertEqual(auth.state, .locked)

    let unlocked = await auth.unlock()
    XCTAssertTrue(unlocked)
    XCTAssertEqual(auth.state, .signedIn)
  }

  func testFailedBiometricCheckStaysLocked() async throws {
    try store.setRefreshToken("sid.0")
    let auth = makeController(appLockSucceeds: false)
    auth.restore()
    auth.isAppLockEnabled = true
    auth.lockIfNeeded()

    let unlocked = await auth.unlock()
    XCTAssertFalse(unlocked)
    XCTAssertEqual(auth.state, .locked)
  }
}
