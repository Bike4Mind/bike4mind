import Foundation

/// What a Siri / Shortcuts / Spotlight invocation asks the app to do, as plain values. The `AppIntent`
/// types in the app target only collect parameters and hand them here, so the mapping is testable
/// without the AppIntents framework.
public enum AssistantRequest: Equatable, Sendable {
  /// "Ask Bike4Mind": a prompt for a new conversation.
  case ask(prompt: String)
  /// "Start quest": open an existing session with the composer focused.
  case startQuest(sessionID: String)
  /// "Capture note to lake": no upload path exists yet, so the note becomes a prefilled draft.
  case captureNote(text: String)

  /// Prefix that tells the assistant what to do with a captured note. v1 stand-in for a real lake upload.
  public static let captureNotePrefix = "Save this note to my data lake:\n\n"

  /// Every intent opens the composer with text in it and sends nothing: a misheard Siri phrase must not
  /// spend credits, and the user reviews the text first.
  public var route: Route {
    switch self {
    case .ask(let prompt):
      return .compose(ComposeRequest(target: .newConversation, draft: Self.clean(prompt)))
    case .startQuest(let sessionID):
      guard DeepLinkRouter.isValidIdentifier(sessionID) else { return .sessions }
      return .compose(ComposeRequest(target: .session(id: sessionID)))
    case .captureNote(let text):
      let note = Self.clean(text)
      return .compose(
        ComposeRequest(target: .newConversation, draft: note.isEmpty ? "" : Self.captureNotePrefix + note))
    }
  }

  private static func clean(_ text: String) -> String {
    text.trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
