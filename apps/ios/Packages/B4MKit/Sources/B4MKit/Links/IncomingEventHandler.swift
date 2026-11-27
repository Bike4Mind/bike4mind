import Foundation

/// Funnels everything that can open the app on a destination (universal links, notification taps)
/// into `AppNavigator`, and answers the foreground-presentation question. Thin by design: the system
/// delegates in the app target only translate callbacks into these calls.
@MainActor
public final class IncomingEventHandler {
  private let navigator: AppNavigator
  private let isShellReady: @MainActor () -> Bool
  private let isAppActive: @MainActor () -> Bool

  public init(
    navigator: AppNavigator,
    isShellReady: @escaping @MainActor () -> Bool,
    isAppActive: @escaping @MainActor () -> Bool = { true }
  ) {
    self.navigator = navigator
    self.isShellReady = isShellReady
    self.isAppActive = isAppActive
  }

  /// - Returns: whether the URL was one of ours.
  @discardableResult
  public func handle(url: URL) -> Bool {
    guard let route = DeepLinkRouter.route(url: url) else { return false }
    navigator.open(route, isShellReady: isShellReady())
    return true
  }

  /// Opens a route raised from inside the app process (App Intents), queued until the shell is ready.
  public func open(_ route: Route) {
    navigator.open(route, isShellReady: isShellReady())
  }

  public func didTapNotification(_ payload: NotificationPayload) {
    guard let route = payload.route else { return }
    navigator.open(route, isShellReady: isShellReady())
  }

  public func presentation(for payload: NotificationPayload) -> ForegroundPresentation {
    // Without a visible shell (locked, signed out) nothing on screen can be "the relevant screen".
    guard isShellReady(), isAppActive() else { return .banner }
    return ForegroundPresentationPolicy.presentation(for: payload, visibility: navigator)
  }
}
