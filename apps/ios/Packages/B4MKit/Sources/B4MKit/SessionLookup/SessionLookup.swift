import Foundation

/// Resolves sessions opened by push, link, or Shortcut without listing session history.
public enum SessionLookup {
  /// Missing or inaccessible ids are omitted, as in the session picker.
  public static func sessions(
    withIDs ids: Set<String>, api: any B4MAPI
  ) async throws -> [SessionSummary] {
    var found: [SessionSummary] = []
    for id in ids.sorted() {
      do {
        found.append(try await api.session(id: id))
      } catch APIError.notFound {
        continue
      }
    }
    return found
  }

  /// A display name for a session opened by id (push, link, intent): the cached list row, then the server's
  /// session, then the opening of the first prompt. `nil` only when none of those has anything to show.
  public static func name(
    forSession id: String, api: any B4MAPI, cache: (any SessionListCache)?, turns: [QuestTurn]
  ) async -> String? {
    if let cached = await cache?.load()?.first(where: { $0.id == id }), let name = nonEmpty(cached.name) {
      return name
    }
    if let session = try? await api.session(id: id), let name = nonEmpty(session.name) {
      return name
    }
    return fallbackName(from: turns)
  }

  /// What a nameless session is called elsewhere in the app (see `QuestActivityTitle`).
  public static func fallbackName(from turns: [QuestTurn]) -> String? {
    guard let prompt = turns.lazy.compactMap(\.prompt).first(where: { nonEmpty($0) != nil }) else { return nil }
    return QuestActivityTitle.fromPrompt(prompt)
  }

  private static func nonEmpty(_ text: String) -> String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}
