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
  /// Open the composer with text already in it. Raised by App Intents (Siri, Shortcuts, Spotlight); the
  /// text is only prefilled, never sent, so a misheard phrase cannot spend credits.
  case compose(ComposeRequest)
  /// A bike4mind.com page with no native screen: handed to Safari rather than dropped.
  case web(URL)

  /// The tab a route lives in; `nil` for `.web`.
  public var tab: AppTab? {
    switch self {
    case .sessions, .session, .compose: .sessions
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

/// A request to open a composer with a draft: in an existing session, or in a new conversation.
public struct ComposeRequest: Hashable, Sendable {
  public enum Target: Hashable, Sendable {
    case session(id: String)
    case newConversation
  }

  public let target: Target
  public let draft: String

  public init(target: Target, draft: String = "") {
    self.target = target
    self.draft = draft
  }
}
