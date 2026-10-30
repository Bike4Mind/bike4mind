import Foundation
import Observation
import os

/// Owns the signed-in session: PKCE sign-in, the Keychain-held rotating refresh token, the
/// in-memory access token, sign-out and the optional App Lock.
///
/// `accessToken()` is the only way any other code obtains a bearer token.
@MainActor
@Observable
public final class AuthController {
  public enum State: Equatable, Sendable {
    /// The Keychain has not been read yet.
    case restoring
    case signedOut(SignOutReason?)
    case signedIn
    /// Signed in, but App Lock hides the UI until `unlock()` succeeds. Tokens keep working.
    case locked
  }

  public enum SignOutReason: Equatable, Sendable {
    case userInitiated
    /// The server ended the session (revoked, expired, or a refresh token replayed past the grace window).
    case sessionEnded
  }

  public private(set) var state: State = .restoring
  public private(set) var environment: ServerEnvironment

  /// Face ID / Touch ID gate on returning to the app. Off by default.
  public var isAppLockEnabled: Bool {
    didSet { preferences.set(isAppLockEnabled, forKey: Self.appLockKey) }
  }

  @ObservationIgnored private let tokenStore: any TokenStore
  @ObservationIgnored private let transport: any HTTPTransport
  @ObservationIgnored private let configuration: OAuthConfiguration
  @ObservationIgnored private let biometricGate: any BiometricGate
  @ObservationIgnored private let deviceName: @MainActor () -> String?
  @ObservationIgnored private let now: @Sendable () -> Date
  @ObservationIgnored private let preferences: UserDefaults
  @ObservationIgnored private let logger = Logger(subsystem: "com.bike4mind.app", category: "auth")

  @ObservationIgnored private var cachedAccessToken: AccessToken?
  @ObservationIgnored private var inFlightRefresh: Task<String, any Error>?
  /// Bumped whenever the session changes hands, so a refresh that lands after sign-out is discarded
  /// instead of writing a dead session's token back to the Keychain.
  @ObservationIgnored private var sessionGeneration = 0

  private static let appLockKey = "b4m.appLockEnabled"

  public init(
    environment: ServerEnvironment,
    tokenStore: any TokenStore,
    transport: any HTTPTransport = URLSessionTransport(),
    configuration: OAuthConfiguration = .iosApp,
    biometricGate: any BiometricGate = LocalAuthenticationGate(),
    preferences: UserDefaults = .standard,
    deviceName: @escaping @MainActor () -> String? = { DeviceName.current },
    now: @escaping @Sendable () -> Date = Date.init
  ) {
    self.environment = environment
    self.tokenStore = tokenStore
    self.transport = transport
    self.configuration = configuration
    self.biometricGate = biometricGate
    self.preferences = preferences
    self.deviceName = deviceName
    self.now = now
    self.isAppLockEnabled = preferences.bool(forKey: Self.appLockKey)
  }

  private var api: AuthAPI {
    AuthAPI(baseURL: environment.baseURL, transport: transport)
  }

  // MARK: - Session lifecycle

  /// Reads the Keychain once at launch. A stored refresh token means signed in; the access token is
  /// minted lazily by the first `accessToken()` call.
  public func restore() {
    guard state == .restoring else { return }
    do {
      let hasSession = try tokenStore.refreshToken() != nil
      state = hasSession ? (isAppLockEnabled ? .locked : .signedIn) : .signedOut(nil)
    } catch {
      logger.error("Keychain read failed during restore: \(error, privacy: .public)")
      state = .signedOut(nil)
    }
  }

  /// Runs the PKCE authorization-code flow through the system web sheet and stores the resulting session.
  public func signIn(using authenticator: any WebAuthenticating) async throws {
    let request = AuthorizationRequest(baseURL: environment.baseURL, configuration: configuration)
    let callbackURL = try await authenticator.authenticate(url: request.url, callbackURL: configuration.redirectURI)
    let code = try request.authorizationCode(from: callbackURL)
    let grant = try await api.exchangeCode(
      code,
      verifier: request.pkce.verifier,
      configuration: configuration,
      deviceName: deviceName()
    )

    try tokenStore.setRefreshToken(grant.refreshToken)
    sessionGeneration += 1
    inFlightRefresh = nil
    cachedAccessToken = AccessToken(value: grant.accessToken, issuedAt: now())
    state = .signedIn
  }

  /// Ends the session locally first, then revokes it on the server best-effort, so sign-out never
  /// hangs on (or is undone by) a flaky network.
  public func signOut() async {
    let refreshToken = try? tokenStore.refreshToken()
    let accessToken = cachedAccessToken.flatMap { $0.isUsable(at: now()) ? $0.value : nil }
    endSession(.userInitiated)
    await revokeRemoteSession(accessToken: accessToken, refreshToken: refreshToken)
  }

  /// Switching servers invalidates the session: tokens belong to the server that minted them.
  public func switchEnvironment(to newEnvironment: ServerEnvironment) async {
    guard newEnvironment != environment else { return }
    if case .signedOut = state {
    } else {
      await signOut()
    }
    environment = newEnvironment
    state = .signedOut(nil)
  }

  // MARK: - Tokens

  /// The in-memory access token, refreshed when missing or about to expire. Concurrent callers share
  /// one refresh request (single flight). Throws `AuthError.signedOut` without touching the network
  /// when there is no session, and `AuthError.refreshRejected` when the server just ended it.
  public func accessToken() async throws -> String {
    if state == .restoring { restore() }
    if case .signedOut = state { throw AuthError.signedOut }

    if let token = cachedAccessToken, token.isUsable(at: now()) {
      return token.value
    }
    if let inFlightRefresh {
      return try await inFlightRefresh.value
    }

    // Unstructured on purpose: one caller's cancellation must not fail the refresh the others await.
    let refresh = Task { try await self.refreshSession() }
    inFlightRefresh = refresh
    defer { if inFlightRefresh == refresh { inFlightRefresh = nil } }
    return try await refresh.value
  }

  /// Drops the cached access token, e.g. after an API call answered 401, so the next
  /// `accessToken()` refreshes.
  public func invalidateAccessToken() {
    cachedAccessToken = nil
  }

  private func refreshSession() async throws -> String {
    let generation = sessionGeneration
    guard let presented = try tokenStore.refreshToken() else {
      endSession(.sessionEnded)
      throw AuthError.signedOut
    }

    do {
      return try await refresh(presenting: presented, generation: generation)
    } catch AuthError.refreshRejected {
      // Another process sharing the Keychain item (the share extension) may have rotated the token
      // while this request was in flight. Retry exactly once with what is stored now; a second
      // rejection is final, so a replayed token can never loop.
      if let current = try? tokenStore.refreshToken(), current != presented, generation == sessionGeneration {
        do {
          return try await refresh(presenting: current, generation: generation)
        } catch AuthError.refreshRejected {
          // Falls through to sign-out below.
        }
      }
      if generation == sessionGeneration {
        logger.notice("Refresh token rejected; signing out")
        endSession(.sessionEnded)
      }
      throw AuthError.refreshRejected
    }
  }

  private func refresh(presenting refreshToken: String, generation: Int) async throws -> String {
    let result = try await api.refresh(refreshToken: refreshToken)
    guard generation == sessionGeneration else {
      // Signed out (or re-signed in) while the request was in flight: this result belongs to a dead session.
      throw AuthError.signedOut
    }

    if let rotated = result.refreshToken {
      do {
        try tokenStore.setRefreshToken(rotated)
      } catch {
        // The access token is still good. The next cold start presents the previous token, which the
        // server's recovery rotation accepts, so log rather than fail the caller.
        logger.error("Persisting rotated refresh token failed: \(error, privacy: .public)")
      }
    }
    let token = AccessToken(value: result.accessToken, issuedAt: now())
    cachedAccessToken = token
    return token.value
  }

  private func endSession(_ reason: SignOutReason) {
    sessionGeneration += 1
    inFlightRefresh = nil
    cachedAccessToken = nil
    do {
      try tokenStore.setRefreshToken(nil)
    } catch {
      logger.error("Wiping refresh token failed: \(error, privacy: .public)")
    }
    state = .signedOut(reason)
  }

  private func revokeRemoteSession(accessToken: String?, refreshToken: String?) async {
    let api = self.api
    do {
      var bearer = accessToken
      if bearer == nil, let refreshToken {
        bearer = try await api.refresh(refreshToken: refreshToken).accessToken
      }
      guard let bearer else { return }
      try await api.logout(accessToken: bearer)
    } catch {
      logger.notice("Server-side logout failed (session already wiped locally): \(error, privacy: .public)")
    }
  }

  // MARK: - App Lock

  /// Call when the app leaves the foreground, so the app switcher snapshot is already hidden.
  public func lockIfNeeded() {
    guard isAppLockEnabled, state == .signedIn else { return }
    state = .locked
  }

  @discardableResult
  public func unlock(reason: String = "Unlock Bike4Mind") async -> Bool {
    guard state == .locked else { return state == .signedIn }
    guard await biometricGate.evaluate(reason: reason) else { return false }
    if state == .locked { state = .signedIn }
    return state == .signedIn
  }

  public var canUseAppLock: Bool {
    biometricGate.canEvaluate()
  }
}
