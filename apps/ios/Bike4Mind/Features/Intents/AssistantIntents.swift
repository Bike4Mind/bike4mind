import AppIntents
import B4MKit

/// Siri / Shortcuts / Spotlight entry points. Each intent only collects parameters and opens the app on a
/// prefilled composer (see `AssistantRequest.route`); nothing is sent until the user taps send.

@MainActor
private func open(_ intent: AssistantRequest) {
  AppDelegate.services?.events.open(intent.route)
}

struct AskBike4MindIntent: AppIntent {
  static let title: LocalizedStringResource = "Ask Bike4Mind"
  static let description = IntentDescription("Start a new conversation with a prompt ready to send.")
  static let openAppWhenRun = true

  @Parameter(title: "Prompt", requestValueDialog: "What do you want to ask?")
  var prompt: String

  @MainActor
  func perform() async throws -> some IntentResult {
    open(.ask(prompt: prompt))
    return .result()
  }
}

// Today this opens a new conversation with the note as its draft; saving straight to a lake natively is the
// follow-up, and the title should change back when it lands.
struct CaptureNoteIntent: AppIntent {
  static let title: LocalizedStringResource = "Capture note"
  static let description = IntentDescription(
    "Start a new conversation with your note ready to send. Nothing is sent until you tap Send.")
  static let openAppWhenRun = true

  @Parameter(title: "Note", requestValueDialog: "What should the note say?")
  var text: String

  @MainActor
  func perform() async throws -> some IntentResult {
    open(.captureNote(text: text))
    return .result()
  }
}

/// A session offered to Siri and Shortcuts as a choice.
struct SessionEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Session"
  static let defaultQuery = SessionEntityQuery()

  let id: String
  let name: String

  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct SessionEntityQuery: EntityStringQuery {
  @MainActor
  private func sessions() async throws -> [SessionEntity] {
    guard let api = AppDelegate.services?.api else { return [] }
    let page = try await api.listSessions(cursor: nil, limit: 25)
    return page.items.map { SessionEntity(id: $0.id, name: $0.name) }
  }

  /// Resolves a saved Shortcut's session however far down the list it has sunk (see `SessionLookup`).
  @MainActor
  func entities(for identifiers: [String]) async throws -> [SessionEntity] {
    guard let api = AppDelegate.services?.api else { return [] }
    return try await SessionLookup.sessions(withIDs: Set(identifiers), api: api)
      .map { SessionEntity(id: $0.id, name: $0.name) }
  }

  func entities(matching string: String) async throws -> [SessionEntity] {
    try await sessions().filter { $0.name.localizedCaseInsensitiveContains(string) }
  }

  func suggestedEntities() async throws -> [SessionEntity] {
    try await sessions()
  }
}

struct StartQuestIntent: AppIntent {
  static let title: LocalizedStringResource = "Start quest"
  static let description = IntentDescription("Open a session with the composer ready.")
  static let openAppWhenRun = true

  @Parameter(title: "Session")
  var session: SessionEntity

  @MainActor
  func perform() async throws -> some IntentResult {
    var route = AssistantRequest.startQuest(sessionID: session.id).route
    if case .compose(let request) = route {
      route = .compose(ComposeRequest(target: request.target, draft: request.draft, sessionName: session.name))
    }
    AppDelegate.services?.events.open(route)
    return .result()
  }
}

struct Bike4MindShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: AskBike4MindIntent(),
      phrases: ["Ask \(.applicationName)", "Ask \(.applicationName) a question"],
      shortTitle: "Ask Bike4Mind", systemImageName: "bubble.left.and.text.bubble.right")
    AppShortcut(
      intent: StartQuestIntent(),
      phrases: ["Start a quest in \(.applicationName)"],
      shortTitle: "Start quest", systemImageName: "play.circle")
    AppShortcut(
      intent: CaptureNoteIntent(),
      phrases: ["Capture a note in \(.applicationName)"],
      shortTitle: "Capture note", systemImageName: "square.and.pencil")
  }
}
