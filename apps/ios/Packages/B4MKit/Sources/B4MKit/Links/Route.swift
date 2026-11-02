import Foundation

/// A destination inside the app. Produced by `DeepLinkRouter` from universal links and notification
/// payloads, consumed by `AppNavigator`. Later milestones extend this enum (chat turns, agent
/// approvals, media items); `AppNavigator.apply` is the one exhaustive switch to update.
public enum Route: Hashable, Sendable {
  /// The Sessions tab root.
  case sessions
  case session(id: String)
  /// The Lakes tab root. Lake detail arrives with its screen; until then `lake` lands on the root.
  case lakes
  case lake(id: String)
  /// The Media tab root.
  case media
  case settings
  /// A bike4mind.com page with no native screen: handed to Safari rather than dropped.
  case web(URL)

  /// The tab a route lives in; `nil` for `.web`.
  public var tab: AppTab? {
    switch self {
    case .sessions, .session: .sessions
    case .lakes, .lake: .lakes
    case .media: .media
    case .settings: .settings
    case .web: nil
    }
  }
}

public enum AppTab: Hashable, Sendable {
  case sessions, lakes, media, settings
}
