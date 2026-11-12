import Foundation

/// Asks WidgetKit to reload timelines. The app target implements it over `WidgetCenter`; B4MKit stays
/// free of WidgetKit so everything here runs in `swift test` on the host.
public protocol WidgetTimelineReloading: Sendable {
  func reload(kinds: [String])
}

public struct NoopWidgetTimelineReloader: WidgetTimelineReloading {
  public init() {}
  public func reload(kinds: [String]) {}
}

/// Turns what the app observes into the widget snapshot, and reloads a widget only when what it would
/// draw actually changed (WidgetKit budgets reloads, and streaming frames arrive many times a second).
public actor WidgetSnapshotRecorder {
  private struct ActiveSession {
    let title: String
    let status: String
    let count: Int
    let touchedAt: Date
  }

  private let store: any WidgetSnapshotStoring
  private let reloader: any WidgetTimelineReloading
  private let now: @Sendable () -> Date
  private var activeSessions: [String: ActiveSession] = [:]

  public init(
    store: any WidgetSnapshotStoring,
    reloader: any WidgetTimelineReloading,
    now: @escaping @Sendable () -> Date = Date.init
  ) {
    self.store = store
    self.reloader = reloader
    self.now = now
  }

  public func recordCredits(_ balance: CreditBalance) {
    var snapshot = store.load() ?? .empty
    let changed = snapshot.credits?.balance != balance.credits
    snapshot.credits = .init(balance: balance.credits, observedAt: now())
    write(snapshot, reload: changed ? [WidgetKind.credits] : [])
  }

  /// Folds one session's turns into the running-agents aggregate. Call whenever a chat screen's turns change.
  public func recordTurns(sessionID: String, sessionTitle: String, turns: [QuestTurn]) {
    let active = turns.filter(Self.isActive)
    if active.isEmpty {
      activeSessions[sessionID] = nil
    } else {
      activeSessions[sessionID] = ActiveSession(
        title: sessionTitle, status: Self.topStatus(of: active), count: active.count, touchedAt: now())
    }
    publishRunning()
  }

  /// The app only observes agents while it is open, so a fresh process knows of none.
  public func clearRunning() {
    activeSessions.removeAll()
    publishRunning()
  }

  /// - Parameter thumbnail: encoded image bytes; without them the widget shows the title only.
  public func recordLatestGeneration(mediaID: String, title: String, createdAt: Date, thumbnail: Data?) {
    var snapshot = store.load() ?? .empty
    if let existing = snapshot.latestGeneration, existing.mediaID == mediaID,
      existing.thumbnailFileName != nil || thumbnail == nil
    {
      return
    }
    let fileName = thumbnail.flatMap { try? store.saveThumbnail($0, for: mediaID) }
    snapshot.latestGeneration = .init(
      mediaID: mediaID, title: title, createdAt: createdAt, thumbnailFileName: fileName)
    write(snapshot, reload: [WidgetKind.latestGeneration])
  }

  /// Forgets everything the widgets know: a signed-out device must not keep showing the last account's data.
  public func signOut() {
    activeSessions.removeAll()
    store.reset()
    reloader.reload(kinds: WidgetKind.all)
  }

  /// Replaces the whole snapshot and reloads everything: fixture runs and sign-out.
  public func replace(with snapshot: WidgetSnapshot) {
    activeSessions.removeAll()
    write(snapshot, reload: WidgetKind.all)
  }

  // MARK: - Running aggregate

  private func publishRunning() {
    // A session is only re-observed while its chat is open, so after leaving it mid-run its entry stops
    // updating. Age it out on the widget's own freshness rule instead of letting other sessions' changes
    // keep republishing it as running.
    let currentTime = now()
    activeSessions = activeSessions.filter {
      currentTime.timeIntervalSince($0.value.touchedAt) <= WidgetEntryMapper.runningAgentsFreshness
    }
    var snapshot = store.load() ?? .empty
    let total = activeSessions.values.reduce(0) { $0 + $1.count }
    let lead = activeSessions.max { $0.value.touchedAt < $1.value.touchedAt }
    let top = lead.map {
      WidgetSnapshot.RunningAgents.Top(sessionID: $0.key, title: $0.value.title, status: $0.value.status)
    }
    let previous = snapshot.runningAgents
    let changed = previous?.count != total || previous?.top != top
    // Stamped with when the lead was last actually seen, not with this write, so the widget's freshness
    // check still fires for an aggregate nobody is observing any more.
    snapshot.runningAgents = .init(count: total, top: top, observedAt: lead?.value.touchedAt ?? currentTime)
    write(snapshot, reload: changed ? [WidgetKind.runningAgents] : [])
  }

  private func write(_ snapshot: WidgetSnapshot, reload kinds: [String]) {
    do {
      try store.save(snapshot)
    } catch {
      // No container (unsigned build, tests): the widgets simply keep their placeholder.
      return
    }
    if !kinds.isEmpty { reloader.reload(kinds: kinds) }
  }

  private static func isActive(_ turn: QuestTurn) -> Bool {
    if turn.pendingAction != nil, !(turn.status?.isTerminal ?? false) { return true }
    guard let status = turn.status else { return false }
    return status == .pending || status == .running
  }

  /// Approval outranks running, which outranks queued: the most actionable state leads the widget.
  private static func topStatus(of turns: [QuestTurn]) -> String {
    if turns.contains(where: { $0.pendingAction != nil }) { return "approval" }
    if turns.contains(where: { $0.status == .running }) { return "running" }
    return "pending"
  }
}
