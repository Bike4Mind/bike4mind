import Foundation
import Observation
import os

/// Owns the push-registration state machine.
///
/// Authorization strategy (two steps, so the system prompt appears when it has a reason to):
/// 1. First signed-in moment: ask for *provisional* authorization. No prompt is shown; the device
///    gets an APNs token and the server can deliver quietly to Notification Center.
/// 2. First value moment (`userDidReachValueMoment()`, e.g. the user opens a conversation): ask for
///    full authorization once, which shows the system alert for banners, sounds and badges.
///
/// Registration with the server happens only while a session is active and delivery is allowed.
/// A denied user is never registered. Sign-out unregisters best-effort *before* the session is
/// torn down, because the unregister call needs the bearer token.
@MainActor
@Observable
public final class PushRegistrationCoordinator {
  public private(set) var authorization: NotificationAuthorization = .notDetermined

  @ObservationIgnored private let center: any NotificationCenterProviding
  @ObservationIgnored private let remote: any RemoteNotificationRegistering
  @ObservationIgnored private let makeAPI: @MainActor () -> any PushTokenAPI
  @ObservationIgnored private let environment: PushEnvironment
  @ObservationIgnored private let appVersion: String?
  @ObservationIgnored private let preferences: UserDefaults
  @ObservationIgnored private let logger = Logger(subsystem: "com.bike4mind.app", category: "push")

  @ObservationIgnored private var isSessionActive = false
  @ObservationIgnored private var deviceToken: String?
  @ObservationIgnored private var registeredToken: String?
  @ObservationIgnored private var inFlightToken: String?

  private static let promptedKey = "b4m.push.fullPromptRequested"

  public init(
    center: any NotificationCenterProviding,
    remote: any RemoteNotificationRegistering,
    makeAPI: @escaping @MainActor () -> any PushTokenAPI,
    environment: PushEnvironment = .forThisBuild,
    appVersion: String? = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
    preferences: UserDefaults = .standard
  ) {
    self.center = center
    self.remote = remote
    self.makeAPI = makeAPI
    self.environment = environment
    self.appVersion = appVersion
    self.preferences = preferences
  }

  // MARK: - Session lifecycle

  /// Call when a session becomes active (sign-in or a restored launch). Registers the device again,
  /// because the server ties a token to the session that registered it.
  public func sessionDidStart() async {
    guard !isSessionActive else { return }
    isSessionActive = true
    registeredToken = nil
    var status = await center.authorizationStatus()
    if status == .notDetermined {
      status = await requestAuthorization(.provisional) ?? status
    }
    authorization = status
    await syncRegistration()
  }

  /// Call when the session ended without our involvement (revoked, expired). Nothing can be sent
  /// without a valid session, so this only forgets local state.
  public func sessionDidEnd() {
    isSessionActive = false
    registeredToken = nil
    inFlightToken = nil
  }

  /// Call just before a user-initiated sign-out. Gives up after `timeout` so sign-out never hangs on
  /// a bad network.
  public func unregisterBeforeSignOut(timeout: Duration = .seconds(3)) async {
    defer { sessionDidEnd() }
    guard let token = registeredToken ?? deviceToken, isSessionActive else { return }
    let api = makeAPI()
    let logger = self.logger
    await withTaskGroup(of: Void.self) { group in
      group.addTask {
        do {
          try await api.unregisterPushToken(token)
        } catch {
          logger.notice("Unregister failed (best effort): \(error, privacy: .public)")
        }
      }
      group.addTask { try? await Task.sleep(for: timeout) }
      await group.next()
      group.cancelAll()
    }
  }

  // MARK: - System callbacks

  public func didReceiveDeviceToken(_ tokenData: Data) async {
    deviceToken = tokenData.map { String(format: "%02x", $0) }.joined()
    await syncRegistration()
  }

  public func didFailToRegister(_ error: any Error) {
    logger.error("APNs registration failed: \(error, privacy: .public)")
  }

  /// Foreground entry: re-reads authorization (the user may have changed it in Settings), retries a
  /// registration that failed earlier and clears the badge.
  public func appDidBecomeActive() async {
    await center.setBadgeCount(0)
    await refreshAuthorization()
  }

  /// The first moment the user sees value from the app. Upgrades provisional (or undetermined)
  /// authorization with the system prompt, at most once per install.
  public func userDidReachValueMoment() async {
    guard isSessionActive, !preferences.bool(forKey: Self.promptedKey) else { return }
    guard authorization == .provisional || authorization == .notDetermined else { return }
    preferences.set(true, forKey: Self.promptedKey)
    _ = await requestAuthorization(.full)
    await refreshAuthorization()
  }

  /// The explicit opt-in from the settings screen. Unlike the value moment this is user-initiated, so
  /// it is not limited to once.
  @discardableResult
  public func requestFullAuthorization() async -> NotificationAuthorization {
    _ = await requestAuthorization(.full)
    await refreshAuthorization()
    return authorization
  }

  public func refreshAuthorization() async {
    authorization = await center.authorizationStatus()
    if authorization == .denied, let token = registeredToken {
      // The user turned notifications off in iOS Settings: stop the server pushing to a mute device.
      registeredToken = nil
      await unregisterQuietly(token)
    }
    await syncRegistration()
  }

  // MARK: - Internals

  private func requestAuthorization(_ kind: AuthorizationRequestKind) async -> NotificationAuthorization? {
    do {
      _ = try await center.requestAuthorization(kind)
    } catch {
      logger.error("Notification authorization request failed: \(error, privacy: .public)")
    }
    let status = await center.authorizationStatus()
    authorization = status
    return status
  }

  private func syncRegistration() async {
    guard isSessionActive, authorization.allowsDelivery else { return }
    remote.registerForRemoteNotifications()
    guard let token = deviceToken, token != registeredToken, token != inFlightToken else { return }

    inFlightToken = token
    defer { if inFlightToken == token { inFlightToken = nil } }
    do {
      try await makeAPI().registerPushToken(token, environment: environment, appVersion: appVersion)
      // The session may have ended while the request was out; do not record it as registered then.
      if isSessionActive { registeredToken = token }
    } catch {
      logger.error("Push token registration failed: \(error, privacy: .public)")
    }
  }

  private func unregisterQuietly(_ token: String) async {
    do {
      try await makeAPI().unregisterPushToken(token)
    } catch {
      logger.notice("Unregister failed (best effort): \(error, privacy: .public)")
    }
  }
}
