import Foundation

/// A destination inside the app. Produced by `DeepLinkRouter` from universal links and notification
/// payloads, consumed by `AppNavigator`. Later milestones extend this enum (chat turns, agent
/// approvals, media items); `AppNavigator.apply` is the one exhaustive switch to update.
public enum Route: Hashable, Sendable {
  /// The Chat tab root: the start-of-chat screen.
  case home
  /// The conversation history, pushed on the Chat tab's home.
  case sessions
  case session(id: String)
  /// The Lakes root. There is no Lakes tab, so `AppNavigator` opens it on the web and stays on the current tab.
  case lakes
  /// No native lake screen exists yet, so `AppNavigator` opens the lake on the web and stays on the current tab.
  /// `DeepLinkRouter` already sends lake links as `.web` with the original URL; this case is for other producers.
  case lake(id: String)
  /// The Media tab root.
  case media
  case settings
  /// Open the composer with text already in it. Raised by App Intents (Siri, Shortcuts, Spotlight); the
  /// text is only prefilled, never sent, so a misheard phrase cannot spend credits.
  case compose(ComposeRequest)
  /// A bike4mind.com page with no native screen: handed to Safari rather than dropped.
  case web(URL)

  /// The tab a route lives in; `nil` for what opens on the web.
  public var tab: AppTab? {
    switch self {
    case .home, .sessions, .session, .compose: .sessions
    case .media: .media
    case .settings: .settings
    case .lakes, .lake, .web: nil
    }
  }
}

public enum AppTab: Hashable, Sendable {
  /// Labelled "Chat": its stack roots at the start-of-chat screen.
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
  /// The session's name when the caller already knows it (a Shortcut's session parameter), so the screen
  /// opened by id is titled at once instead of after a lookup.
  public let sessionName: String

  public init(target: Target, draft: String = "", sessionName: String = "") {
    self.target = target
    self.draft = draft
    self.sessionName = sessionName
  }
}
