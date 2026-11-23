import Foundation

/// Memory-only history, cleared on sign-out by RootView. Live turns never enter this cache.
@MainActor
public final class SettledTranscriptCache {
  struct Snapshot {
    let pages: [Page<QuestTurn>]
    let revalidateLastPage: Bool
  }

  private struct Key: Hashable {
    let sessionID: String
    let pageSize: Int
  }

  private let maxSessions: Int
  private let maxPages: Int
  private var entries: [Key: Snapshot] = [:]
  private var recency: [Key] = []
  private(set) var generation = UUID()

  public init(maxSessions: Int = 20, maxPages: Int = 4) {
    self.maxSessions = max(1, maxSessions)
    self.maxPages = max(1, maxPages)
  }

  public func invalidate() {
    generation = UUID()
    entries.removeAll()
    recency.removeAll()
  }

  func load(sessionID: String, pageSize: Int) -> Snapshot? {
    let key = Key(sessionID: sessionID, pageSize: pageSize)
    guard let snapshot = entries[key] else { return nil }
    touch(key)
    return snapshot
  }

  /// Drops a session's entries so the next open fetches it; for sends made outside a transcript view model.
  public func remove(sessionID: String) {
    remove(sessionID: sessionID, generation: generation)
  }

  func remove(sessionID: String, generation: UUID) {
    guard generation == self.generation else { return }
    entries = entries.filter { $0.key.sessionID != sessionID }
    recency.removeAll { $0.sessionID == sessionID }
  }

  func save(sessionID: String, pageSize: Int, pages: [Page<QuestTurn>], generation: UUID) {
    guard generation == self.generation, pageSize > 0, pageSize <= 50 else { return }
    var settled: [Page<QuestTurn>] = []
    var revalidate = false
    for page in pages.prefix(maxPages) {
      guard page.items.count <= pageSize else {
        remove(sessionID: sessionID, generation: generation)
        return
      }
      let prefix = page.items.prefix {
        $0.status?.isTerminal
          ?? ($0.kind == .error || !($0.reply?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true))
      }
      if settled.isEmpty, prefix.isEmpty, !page.items.isEmpty {
        remove(sessionID: sessionID, generation: generation)
        return
      }
      settled.append(Page(items: Array(prefix), nextCursor: page.nextCursor))
      if prefix.count != page.items.count {
        revalidate = true
        break
      }
    }
    guard !settled.isEmpty else { return }
    let key = Key(sessionID: sessionID, pageSize: pageSize)
    entries[key] = Snapshot(pages: settled, revalidateLastPage: revalidate)
    touch(key)
    while recency.count > maxSessions {
      entries.removeValue(forKey: recency.removeFirst())
    }
  }

  private func touch(_ key: Key) {
    recency.removeAll { $0 == key }
    recency.append(key)
  }
}
