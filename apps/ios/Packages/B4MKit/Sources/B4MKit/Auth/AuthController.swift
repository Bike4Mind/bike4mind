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
  @ObservationIgnored private var inFlightUnlock: Task<Bool, Never>?
  /// Bumped whenever the session changes hands, so a refresh that lands after sign-out is discarded
  /// instead of writing a dead session's token back to the Keychain.
  private var sessionGeneration = UUID()
  @ObservationIgnored private var isRetryingRevocations = false
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
    sessionGeneration = UUID()
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

  /// Immutable identity for work admitted under one account and server, including a cold restore.
  public struct Session: Equatable, Sendable {
    public let id: UUID
    public let environment: ServerEnvironment
  }

  public func captureSession() -> Session {
    Session(id: sessionGeneration, environment: environment)
  }

  public func isCurrent(_ session: Session) -> Bool {
    guard session.id == sessionGeneration, session.environment == environment else { return false }
    if case .signedOut = state { return false }
    return true
  }

  public func scopedTokens(for session: Session) -> any AccessTokenProviding {
    SessionTokens(auth: self, session: session)
  }

  @MainActor
  private final class SessionTokens: AccessTokenProviding {
    private let auth: AuthController
    private let session: Session

    init(auth: AuthController, session: Session) {
      self.auth = auth
      self.session = session
    }

    func accessToken() async throws -> String {
      guard auth.isCurrent(session) else { throw AuthError.signedOut }
      let token = try await auth.accessToken()
      guard auth.isCurrent(session) else { throw AuthError.signedOut }
      return token
    }

    func invalidateAccessToken(_ token: String) {
      guard auth.isCurrent(session) else { return }
      auth.invalidateAccessToken(token)
    }

    func sessionRejected() {
      guard auth.isCurrent(session) else { return }
      auth.sessionRejected()
    }
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
    let generation = sessionGeneration
    let refresh = Task { try await self.refreshSession(generation: generation) }
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

  private func refreshSession(generation: UUID) async throws -> String {
    guard generation == sessionGeneration else { throw AuthError.signedOut }
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

  private func refresh(presenting refreshToken: String, generation: UUID) async throws -> String {
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
    sessionGeneration = UUID()
    inFlightRefresh = nil
    cachedAccessToken = nil
    do {
      try tokenStore.setRefreshToken(nil)
    } catch {
      logger.error("Wiping refresh token failed: \(error, privacy: .public)")
    }
    state = .signedOut(reason)
  }

  /// A revocation that fails (offline, server error) is kept and retried by `retryPendingRevocations()`, so the
  /// server ends the session, and the push tokens bound to it, once it is reachable again.
  private func revokeRemoteSession(accessToken: String?, refreshToken: String?) async {
    let api = self.api
    let baseURL = environment.baseURL
    var latestRefreshToken = refreshToken
    do {
      var bearer = accessToken
      if bearer == nil, let refreshToken {
        let refreshed = try await api.refresh(refreshToken: refreshToken)
        bearer = refreshed.accessToken
        latestRefreshToken = refreshed.refreshToken ?? refreshToken
      }
      guard let bearer else { return }
      try await api.logout(accessToken: bearer)
    } catch AuthError.refreshRejected {
      return
    } catch {
      logger.notice("Server-side logout failed; will retry: \(error, privacy: .public)")
      guard let latestRefreshToken else { return }
      updatePendingRevocations(
        removing: [],
        adding: [PendingRevocation(baseURL: baseURL, refreshToken: latestRefreshToken, createdAt: now())])
    }
  }

  /// Finishes revocations an earlier sign-out on this server could not complete. Call at launch and on foreground.
  public func retryPendingRevocations() async {
    guard !isRetryingRevocations else { return }
    isRetryingRevocations = true
    defer { isRetryingRevocations = false }
    let pending: [PendingRevocation]
    do {
      pending = try tokenStore.pendingRevocations().filter { $0.baseURL == environment.baseURL }
    } catch {
      logger.notice("Pending revocations not readable yet: \(error, privacy: .public)")
      return
    }
    guard !pending.isEmpty else { return }
    var stillPending: [PendingRevocation] = []
    for revocation in PendingRevocation.bounded(pending, now: now()) {
      if let retry = await revoke(revocation) { stillPending.append(retry) }
    }
    updatePendingRevocations(removing: pending, adding: stillPending)
  }

  /// `nil` once the server no longer holds the session; otherwise what to retry with next time.
  private func revoke(_ revocation: PendingRevocation) async -> PendingRevocation? {
    let api = AuthAPI(baseURL: revocation.baseURL, transport: transport)
    var current = revocation
    do {
      let refreshed = try await api.refresh(refreshToken: revocation.refreshToken)
      if let rotated = refreshed.refreshToken {
        current = PendingRevocation(
          baseURL: revocation.baseURL, refreshToken: rotated, createdAt: revocation.createdAt)
      }
      try await api.logout(accessToken: refreshed.accessToken)
      return nil
    } catch AuthError.refreshRejected {
      return nil
    } catch {
      return current
    }
  }

  /// Read-modify-write against the latest stored list, since a sign-out can add one while a retry is awaiting.
  private func updatePendingRevocations(removing: [PendingRevocation], adding: [PendingRevocation]) {
    do {
      let latest = try tokenStore.pendingRevocations()
      try tokenStore.setPendingRevocations(
        PendingRevocation.bounded(latest.filter { !removing.contains($0) } + adding, now: now()))
    } catch {
      logger.error("Saving pending revocations failed: \(error, privacy: .public)")
    }
  }

  // MARK: - App Lock

  /// Call when the app leaves the foreground, so the app switcher snapshot is already hidden.
  public func lockIfNeeded() {
    guard isAppLockEnabled, state == .signedIn else { return }
    state = .locked
  }

  /// Callers that arrive while a prompt is up share its result instead of raising a second one.
  @discardableResult
  public func unlock(reason: String = "Unlock Bike4Mind") async -> Bool {
    guard state == .locked else { return state == .signedIn }
    if let inFlightUnlock { return await inFlightUnlock.value }
    let attempt = Task { [biometricGate] in
      defer { inFlightUnlock = nil }
      guard await biometricGate.evaluate(reason: reason) else { return false }
      if state == .locked { state = .signedIn }
      return state == .signedIn
    }
    inFlightUnlock = attempt
    return await attempt.value
  }

  public var canUseAppLock: Bool {
    biometricGate.canEvaluate()
  }
}
