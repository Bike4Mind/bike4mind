import Foundation

/// Finds sessions by id. The public API has no fetch-by-id for a session, so this scans the session list,
/// which is newest first, for a bounded number of pages: enough for any session a person still opens from a
/// link or a saved Shortcut, without an unbounded loop of requests.
public enum SessionLookup {
  public static let pageSize = 50
  public static let maxPages = 20

  /// The sessions among `ids` that the scan reached; ids it did not reach are left out.
  public static func sessions(
    withIDs ids: Set<String>, api: any B4MAPI, maxPages: Int = maxPages
  ) async throws -> [SessionSummary] {
    var remaining = ids
    var found: [SessionSummary] = []
    var cursor: String?
    for _ in 0..<maxPages {
      guard !remaining.isEmpty else { break }
      let page = try await api.listSessions(cursor: cursor, limit: pageSize)
      for session in page.items where remaining.remove(session.id) != nil {
        found.append(session)
      }
      guard let next = page.nextCursor else { break }
      cursor = next
    }
    return found
  }

  /// A display name for a session opened by id (push, link, intent): the cached list row, then the server's
  /// list, then the opening of the first prompt. `nil` only when none of those has anything to show.
  public static func name(
    forSession id: String, api: any B4MAPI, cache: (any SessionListCache)?, turns: [QuestTurn]
  ) async -> String? {
    if let cached = await cache?.load()?.first(where: { $0.id == id }), let name = nonEmpty(cached.name) {
      return name
    }
    // A failed scan is not worth an error on a screen that already loaded: the prompt still names it.
    if let listed = try? await sessions(withIDs: [id], api: api).first, let name = nonEmpty(listed.name) {
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
