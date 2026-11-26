import Foundation

/// Read-only access to the device calendar. The EventKit implementation lives in the app target.
public protocol BusyBlockReader: Sendable {
  func access() -> BusyBlockAccess
  /// Prompts for calendar access when it was never asked; returns whether reading is allowed.
  func requestAccess() async -> Bool
  func events(from start: Date, to end: Date) -> [CalendarEventSample]
}

public enum BusyBlockAccess: Sendable {
  case notDetermined, authorized, denied
}

/// What one `BusyBlockSyncer.sync` call did, so a background run can report failure to the system.
public enum BusyBlockSyncOutcome: Equatable, Sendable {
  /// The server now holds the device's blocks (an empty list when calendar access was revoked).
  case synced
  case skipped(Reason)
  /// Offline, a server error, a cancelled run or an unreadable keychain: the server's blocks are unchanged.
  case failed

  public enum Reason: Equatable, Sendable {
    case inFlight, throttled, neverAsked, disabled, signedOut
  }
}

/// Pushes the device's upcoming busy blocks to the server while the user has busy-block briefs on.
/// The server's opt-in is read first, so an account that never enabled the feature is never written; a device never
/// asked for calendar access skips the request entirely, since enabling always asks.
@MainActor
public final class BusyBlockSyncer {
  /// Foreground and calendar-change syncs closer together than this are skipped.
  public static let minInterval: TimeInterval = 60

  private let api: any BusyBlocksAPI
  private let reader: any BusyBlockReader
  private let now: @Sendable () -> Date
  private var lastSync: Date?
  /// Bumped by `reset()` so a sync still running for the previous account does not stamp `lastSync`.
  private var generation = 0
  /// One lock for background syncs and user saves, so a sync that read the opt-in before a toggle-off cannot
  /// write it back on afterwards.
  private var isBusy = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  public init(api: any BusyBlocksAPI, reader: any BusyBlockReader, now: @escaping @Sendable () -> Date = { Date() }) {
    self.api = api
    self.reader = reader
    self.now = now
  }

  /// Blocks from the device calendar for the sync horizon; empty when access is off.
  public func currentBlocks() -> [BusyBlock] {
    guard reader.access() == .authorized else { return [] }
    let at = now()
    let events = reader.events(
      from: at.addingTimeInterval(-BusyBlockFilter.lookBehind), to: at.addingTimeInterval(BusyBlockFilter.lookAhead))
    return BusyBlockFilter.blocks(from: events)
  }

  /// A revoked calendar permission syncs an empty list, so stale blocks stop holding pushes. A failed sync leaves
  /// the throttle untouched, so the next foreground or background run retries at once.
  @discardableResult
  public func sync(force: Bool = false) async -> BusyBlockSyncOutcome {
    guard !isBusy else { return .skipped(.inFlight) }
    guard reader.access() != .notDetermined else { return .skipped(.neverAsked) }
    if !force, let lastSync, now().timeIntervalSince(lastSync) < Self.minInterval { return .skipped(.throttled) }
    isBusy = true
    defer { release() }
    let startedIn = generation
    do {
      guard try await api.state().enabled else {
        if generation == startedIn { lastSync = now() }
        return .skipped(.disabled)
      }
      _ = try await api.save(enabled: true, blocks: currentBlocks())
      if generation == startedIn { lastSync = now() }
      return .synced
    } catch APIError.signedOut {
      return .skipped(.signedOut)
    } catch {
      return .failed
    }
  }

  /// Clears the throttle on sign-out, so the next account's first sync is not skipped.
  public func reset() {
    lastSync = nil
    generation += 1
  }

  /// Saves the user's opt-in, waiting for any sync in flight to finish first.
  public func save(enabled: Bool) async throws -> BusyBlocksState {
    while isBusy { await withCheckedContinuation { waiters.append($0) } }
    isBusy = true
    defer { release() }
    return try await api.save(enabled: enabled, blocks: enabled ? currentBlocks() : [])
  }

  /// Woken waiters re-check `isBusy`, since a sync can take the lock before they resume.
  private func release() {
    isBusy = false
    let woken = waiters
    waiters = []
    woken.forEach { $0.resume() }
  }
}
