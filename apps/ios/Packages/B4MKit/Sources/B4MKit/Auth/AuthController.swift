import Foundation
import Observation
import Security
import os

#if canImport(UIKit)
  import UIKit
#endif

/// Owns the signed-in session: PKCE sign-in, the Keychain-held rotating refresh token, the
/// in-memory access token, sign-out and the optional App Lock.
///
/// `accessToken()` is the only way any other code obtains a bearer token.
@MainActor
@Observable
public final class AuthController: AccessTokenProviding {
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
    /// The user asked to delete the account; the server revoked every session and holds the account for a grace period.
    case accountDeletionRequested
  }

  public private(set) var state: State = .restoring
  public private(set) var environment: ServerEnvironment

  /// Face ID / Touch ID gate on returning to the app. Off by default.
  public var isAppLockEnabled: Bool {
    didSet { preferences.set(isAppLockEnabled, forKey: Self.appLockKey) }
  }

  @ObservationIgnored private let tokenStore: any TokenStore
  @ObservationIgnored private let transport: any HTTPTransport
  /// Picked per server at sign-in time, so a server switch also switches the OAuth client.
  @ObservationIgnored private let oauthConfiguration: @Sendable (ServerEnvironment) -> OAuthConfiguration
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
  @ObservationIgnored private var rotationContinuations: [UUID: AsyncStream<String>.Continuation] = [:]
  @ObservationIgnored private var protectedDataObservers: [any NSObjectProtocol] = []

  private static let appLockKey = "b4m.appLockEnabled"

  public init(
    environment: ServerEnvironment,
    tokenStore: any TokenStore,
    transport: any HTTPTransport = URLSessionTransport(),
    oauthConfiguration: @escaping @Sendable (ServerEnvironment) -> OAuthConfiguration = { _ in .iosApp },
    biometricGate: any BiometricGate = LocalAuthenticationGate(),
    preferences: UserDefaults = .standard,
    deviceName: @escaping @MainActor () -> String? = { DeviceName.current },
    now: @escaping @Sendable () -> Date = Date.init
  ) {
    self.environment = environment
    self.tokenStore = tokenStore
    self.transport = transport
    self.oauthConfiguration = oauthConfiguration
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

  /// Reads the Keychain at launch. A stored refresh token means signed in; the access token is minted
  /// lazily by the first `accessToken()` call. A Keychain that is not readable yet (launched before first
  /// unlock) leaves the state `.restoring` and retries when protected data becomes available or the app
  /// returns to the foreground: it is not evidence of a signed-out user.
  public func restore() {
    guard state == .restoring else { return }
    do {
      let hasSession = try tokenStore.refreshToken() != nil
      state = hasSession ? (isAppLockEnabled ? .locked : .signedIn) : .signedOut(nil)
    } catch let error as KeychainError where error.isTransient {
      logger.notice("Keychain not readable yet (status \(error.status, privacy: .public)); restore deferred")
      observeProtectedDataIfNeeded()
    } catch {
      logger.error("Keychain read failed during restore: \(error, privacy: .public)")
      state = .signedOut(nil)
    }
  }

  private func observeProtectedDataIfNeeded() {
    guard protectedDataObservers.isEmpty else { return }
    for name in Self.restoreRetryNotifications {
      let observer = NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) {
        [weak self] _ in
        MainActor.assumeIsolated { self?.retryDeferredRestore() }
      }
      protectedDataObservers.append(observer)
    }
  }

  private func retryDeferredRestore() {
    restore()
    guard state != .restoring else { return }
    for observer in protectedDataObservers { NotificationCenter.default.removeObserver(observer) }
    protectedDataObservers = []
  }

  private static var restoreRetryNotifications: [Notification.Name] {
    #if canImport(UIKit)
      [UIApplication.protectedDataDidBecomeAvailableNotification, UIApplication.willEnterForegroundNotification]
    #else
      []
    #endif
  }

  /// Runs the PKCE authorization-code flow through the system web sheet and stores the resulting session.
  public func signIn(using authenticator: any WebAuthenticating) async throws {
    let configuration = oauthConfiguration(environment)
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
  public func signOut(reason: SignOutReason = .userInitiated) async {
    let refreshToken = try? tokenStore.refreshToken()
    let accessToken = cachedAccessToken.flatMap { $0.isUsable(at: now()) ? $0.value : nil }
    endSession(reason)
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
    if state == .restoring { throw KeychainError(status: errSecInteractionNotAllowed) }
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

  /// Drops the cached access token after an API call carrying `rejected` answered 401, so the next
  /// `accessToken()` refreshes. A token already replaced by a newer one is left alone: N concurrent
  /// 401s on the same stale token cause one refresh, not N.
  public func invalidateAccessToken(_ rejected: String) {
    guard cachedAccessToken?.value == rejected else { return }
    cachedAccessToken = nil
  }

  /// The server refused a token minted moments ago, so refreshing again cannot help. Ends the session
  /// the same way a rejected refresh does.
  public func sessionRejected() {
    guard case .signedOut = state else {
      endSession(.sessionEnded)
      return
    }
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
    for continuation in rotationContinuations.values { continuation.yield(token.value) }
    return token.value
  }

  /// Every access token minted by a refresh from now on. Long-lived connections that authenticated
  /// with an earlier token (the realtime socket) move onto each one.
  public func accessTokenRotations() -> AsyncStream<String> {
    let (stream, continuation) = AsyncStream<String>.makeStream(bufferingPolicy: .bufferingNewest(1))
    let id = UUID()
    continuation.onTermination = { [weak self] _ in
      Task { @MainActor in self?.rotationContinuations[id] = nil }
    }
    rotationContinuations[id] = continuation
    return stream
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
