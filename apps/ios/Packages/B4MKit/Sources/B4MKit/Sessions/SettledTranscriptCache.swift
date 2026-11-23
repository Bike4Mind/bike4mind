import Foundation

/// Memory-only history, cleared on sign-out by RootView. Live turns never enter this cache.
@MainActor
public final class SettledTranscriptCache {
  struct Snapshot {
    let pages: [Page<QuestTurn>]
    let revalidateLastPage: Bool
  }

  struct Token: Equatable, Sendable {
    fileprivate let value: UUID
  }

  struct Admission {
    let snapshot: Snapshot?
    let token: Token
  }

  private struct Entry {
    let token: Token
    var snapshot: Snapshot?
  }

  private struct Key: Hashable {
    let sessionID: String
    let pageSize: Int
  }

  private let maxSessions: Int
  private let maxPages: Int
  private var entries: [Key: Entry] = [:]
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
    guard let snapshot = entries[key]?.snapshot else { return nil }
    touch(key)
    return snapshot
  }

  /// Reserves bounded ownership even on a miss. Removing or evicting the entry revokes its token.
  func begin(sessionID: String, pageSize: Int, generation: UUID) -> Admission? {
    guard generation == self.generation, pageSize > 0, pageSize <= 50 else { return nil }
    let key = Key(sessionID: sessionID, pageSize: pageSize)
    let snapshot = entries[key]?.snapshot
    let token = Token(value: UUID())
    entries[key] = Entry(token: token, snapshot: snapshot)
    touch(key)
    while recency.count > maxSessions {
      entries.removeValue(forKey: recency.removeFirst())
    }
    return Admission(snapshot: snapshot, token: token)
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

  func save(sessionID: String, pageSize: Int, pages: [Page<QuestTurn>], generation: UUID, token: Token) {
    let key = Key(sessionID: sessionID, pageSize: pageSize)
    guard generation == self.generation, pageSize > 0, pageSize <= 50,
      var entry = entries[key], entry.token == token
    else { return }
    var settled: [Page<QuestTurn>] = []
    var revalidate = false
    for page in pages.prefix(maxPages) {
      guard page.items.count <= pageSize else {
        entries.removeValue(forKey: key)
        recency.removeAll { $0 == key }
        return
      }
      let prefix = page.items.prefix {
        $0.status?.isTerminal
          ?? ($0.kind == .error || !($0.reply?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true))
      }
      if settled.isEmpty, prefix.isEmpty, !page.items.isEmpty {
        entries.removeValue(forKey: key)
        recency.removeAll { $0 == key }
        return
      }
      settled.append(Page(items: Array(prefix), nextCursor: page.nextCursor))
      if prefix.count != page.items.count {
        revalidate = true
        break
      }
    }
    guard !settled.isEmpty else { return }
    entry.snapshot = Snapshot(pages: settled, revalidateLastPage: revalidate)
    entries[key] = entry
    touch(key)
  }

  private func touch(_ key: Key) {
    recency.removeAll { $0 == key }
    recency.append(key)
  }
}
