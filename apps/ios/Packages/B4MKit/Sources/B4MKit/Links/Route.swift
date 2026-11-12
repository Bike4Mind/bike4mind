import Foundation

/// A destination inside the app. Produced by `DeepLinkRouter` from universal links and notification
/// payloads, consumed by `AppNavigator`. Later milestones extend this enum (chat turns, agent
/// approvals, media items); `AppNavigator.apply` is the one exhaustive switch to update.
public enum Route: Hashable, Sendable {
  /// The start-of-chat screen, the root of the single navigation stack.
  case home
  /// The notebook list, pushed on the home screen.
  case sessions
  case session(id: String)
  /// The Lakes root. There is no native lakes screen, so `AppNavigator` opens it on the web and leaves the stack alone.
  case lakes
  /// No native lake screen exists yet, so `AppNavigator` opens the lake on the web and leaves the stack alone.
  /// `DeepLinkRouter` already sends lake links as `.web` with the original URL; this case is for other producers.
  case lake(id: String)
  /// The Studio gallery, pushed on the home screen (code name stays `media`).
  case media
  /// Settings, pushed on the home screen (opened from the avatar or the drawer's account row).
  case settings
  /// Open the composer with text already in it. Raised by App Intents (Siri, Shortcuts, Spotlight); the
  /// text is only prefilled, never sent, so a misheard phrase cannot spend credits.
  case compose(ComposeRequest)
  /// A bike4mind.com page with no native screen: handed to Safari rather than dropped.
  case web(URL)
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
