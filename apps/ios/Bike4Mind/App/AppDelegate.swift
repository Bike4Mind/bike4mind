import B4MKit
import UIKit
import UserNotifications

/// Bridges the callbacks SwiftUI has no hook for (APNs token, notification taps and foreground
/// presentation) into `AppServices`. Holds no logic of its own.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  /// Set by `Bike4MindApp.init`, before the system can deliver any of these callbacks.
  @MainActor static var services: AppServices?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    return true
  }

  /// The system relaunched the app to deliver background upload events (a share-extension or app upload that
  /// finished while the process was gone). The completion handler is called once they are all delivered.
  func application(
    _ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    let completion = UncheckedSendableBox(completionHandler)
    Task { @MainActor in
      guard let services = Self.services else { return completion.value() }
      services.reattachCaptureSession(identifier: identifier) { completion.value() }
    }
  }

  func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    Task { @MainActor in await Self.services?.push.didReceiveDeviceToken(deviceToken) }
  }

  func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
    Task { @MainActor in Self.services?.push.didFailToRegister(error) }
  }

  // Nonisolated completion-handler forms: the UserNotifications types are not Sendable, so the payload is
  // extracted here and only that Sendable value crosses to the main actor.
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping @Sendable (UNNotificationPresentationOptions) -> Void
  ) {
    let payload = NotificationPayload(userInfo: notification.request.content.userInfo)
    Task { @MainActor in
      switch Self.services?.events.presentation(for: payload) ?? .banner {
      case .banner: completionHandler([.banner, .list, .sound])
      case .suppress: completionHandler([])
      }
    }
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping @Sendable () -> Void
  ) {
    let isDefaultTap = response.actionIdentifier == UNNotificationDefaultActionIdentifier
    let payload = NotificationPayload(userInfo: response.notification.request.content.userInfo)
    Task { @MainActor in
      if isDefaultTap { Self.services?.events.didTapNotification(payload) }
      completionHandler()
    }
  }
}

/// The system's completion handler is not marked Sendable but is documented as callable from the main thread,
/// which is where it is invoked.
private struct UncheckedSendableBox<Value>: @unchecked Sendable {
  let value: Value
  init(_ value: Value) { self.value = value }
}
