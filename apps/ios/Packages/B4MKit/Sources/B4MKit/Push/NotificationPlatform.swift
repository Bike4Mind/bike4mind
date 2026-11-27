import Foundation
import UserNotifications

#if canImport(UIKit)
  import UIKit
#endif

/// Mirror of `UNAuthorizationStatus`, so logic code and tests never touch UserNotifications types.
public enum NotificationAuthorization: Equatable, Sendable {
  case notDetermined
  case denied
  /// Quiet delivery to Notification Center only, granted without a prompt.
  case provisional
  case authorized

  /// Whether registering for remote notifications is worthwhile.
  public var allowsDelivery: Bool {
    switch self {
    case .provisional, .authorized: true
    case .notDetermined, .denied: false
    }
  }
}

public enum AuthorizationRequestKind: Equatable, Sendable {
  /// No prompt; notifications arrive quietly until the user opts in.
  case provisional
  /// The system alert asking for banners, sounds and badges.
  case full
}

/// The slice of `UNUserNotificationCenter` the app uses.
@MainActor
public protocol NotificationCenterProviding: AnyObject {
  func authorizationStatus() async -> NotificationAuthorization
  /// - Returns: whether delivery is allowed afterwards.
  func requestAuthorization(_ kind: AuthorizationRequestKind) async throws -> Bool
  func setBadgeCount(_ count: Int) async
}

/// `UIApplication.registerForRemoteNotifications`, behind a seam. The token arrives later through
/// `PushRegistrationCoordinator.didReceiveDeviceToken(_:)`.
@MainActor
public protocol RemoteNotificationRegistering: AnyObject {
  func registerForRemoteNotifications()
}

/// Opens the iOS Settings page for this app (used when notifications are denied).
@MainActor
public protocol SystemSettingsOpening: AnyObject {
  func openAppSettings()
}

public final class SystemNotificationCenter: NotificationCenterProviding {
  private let center: UNUserNotificationCenter

  public init(center: UNUserNotificationCenter = .current()) {
    self.center = center
  }

  public func authorizationStatus() async -> NotificationAuthorization {
    switch await center.notificationSettings().authorizationStatus {
    case .notDetermined: .notDetermined
    case .denied: .denied
    case .provisional: .provisional
    // Ephemeral (App Clips) is not a state this app can reach; treat it like authorized.
    case .authorized, .ephemeral: .authorized
    @unknown default: .denied
    }
  }

  public func requestAuthorization(_ kind: AuthorizationRequestKind) async throws -> Bool {
    let options: UNAuthorizationOptions =
      switch kind {
      case .provisional: [.alert, .sound, .badge, .provisional]
      case .full: [.alert, .sound, .badge]
      }
    return try await center.requestAuthorization(options: options)
  }

  public func setBadgeCount(_ count: Int) async {
    try? await center.setBadgeCount(count)
  }
}

#if canImport(UIKit)
  public final class SystemRemoteNotificationRegistrar: RemoteNotificationRegistering, SystemSettingsOpening {
    public init() {}

    public func registerForRemoteNotifications() {
      UIApplication.shared.registerForRemoteNotifications()
    }

    public func openAppSettings() {
      guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
      UIApplication.shared.open(url)
    }
  }
#endif
