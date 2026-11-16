import Foundation

/// What a Bike4Mind push carries beyond the `aps` dictionary.
public struct NotificationPayload: Equatable, Sendable {
  public let deepLink: URL?
  public let sessionID: String?
  public let questID: String?
  public let category: NotificationCategory?
  /// `approval_needed` pushes: the pending action the notification buttons answer.
  public let approval: PendingActionTarget?

  public init(
    deepLink: URL? = nil, sessionID: String? = nil, questID: String? = nil, category: NotificationCategory? = nil,
    approval: PendingActionTarget? = nil
  ) {
    self.deepLink = deepLink
    self.sessionID = sessionID
    self.questID = questID
    self.category = category
    self.approval = approval
  }

  /// Parses `UNNotificationContent.userInfo`. Unknown or malformed fields are dropped, never fatal.
  public init(userInfo: [AnyHashable: Any]) {
    deepLink = (userInfo["deepLink"] as? String).flatMap(URL.init(string:))
    sessionID = userInfo["sessionId"] as? String
    questID = userInfo["questId"] as? String
    let rawCategory =
      (userInfo["category"] as? String) ?? (userInfo["aps"] as? [String: Any])?["category"] as? String
    category = rawCategory.flatMap(NotificationCategory.init(rawValue:))
    approval = Self.approval(in: userInfo)
  }

  /// The server's `approval: {questId, pendingActionTs, actions}` object. Anything missing or malformed means
  /// there is nothing to answer from the notification (it never falls back to a guess).
  private static func approval(in userInfo: [AnyHashable: Any]) -> PendingActionTarget? {
    guard let object = userInfo["approval"] as? [String: Any],
      let questID = object["questId"] as? String, DeepLinkRouter.isValidIdentifier(questID),
      let number = object["pendingActionTs"] as? NSNumber, number.int64Value > 0
    else { return nil }
    return PendingActionTarget(questID: questID, pendingActionTs: number.int64Value)
  }

  /// Where tapping the notification should go: the `deepLink` when it routes, else the session id.
  public var route: Route? {
    if let deepLink, let route = DeepLinkRouter.route(url: deepLink) { return route }
    guard let sessionID, DeepLinkRouter.isValidIdentifier(sessionID) else { return nil }
    return .session(id: sessionID)
  }
}

public enum ForegroundPresentation: Equatable, Sendable {
  /// Banner and sound.
  case banner
  case suppress
}

/// What the app asks while a notification arrives in the foreground.
@MainActor
public protocol RouteVisibilityProviding: AnyObject {
  /// Whether the screen for `route` is on screen right now.
  func isShowing(_ route: Route) -> Bool
}

extension AppNavigator: RouteVisibilityProviding {}

public enum ForegroundPresentationPolicy {
  /// Banner + sound unless the user is already looking at what the notification is about.
  @MainActor
  public static func presentation(
    for payload: NotificationPayload, visibility: any RouteVisibilityProviding
  )
    -> ForegroundPresentation
  {
    guard let route = payload.route, visibility.isShowing(route) else { return .banner }
    return .suppress
  }
}
