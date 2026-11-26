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
  private var current: Task<BusyBlockSyncOutcome, Never>?
  /// The latest outcome that says something about the account or device; `inFlight` and `throttled` leave it alone.
  public private(set) var lastOutcome: BusyBlockSyncOutcome?

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
    guard current == nil else { return .skipped(.inFlight) }
    guard reader.access() != .notDetermined else { return record(.skipped(.neverAsked)) }
    if !force, let lastSync, now().timeIntervalSince(lastSync) < Self.minInterval { return .skipped(.throttled) }
    let task = Task { await perform() }
    current = task
    defer { current = nil }
    return record(
      await withTaskCancellationHandler {
        await task.value
      } onCancel: {
        task.cancel()
      })
  }

  /// A forced sync, or the outcome of the one already running, so a caller that must report success waits for it.
  /// Cancelling the caller does not cancel a sync it joined.
  public func syncJoiningInFlight() async -> BusyBlockSyncOutcome {
    if let current { return await current.value }
    return await sync(force: true)
  }

  /// Records a toggle save made outside `sync`: turning it on pushed the current blocks, turning it off cleared them.
  public func recordSave(enabled: Bool) {
    lastOutcome = enabled ? .synced : .skipped(.disabled)
  }

  private func perform() async -> BusyBlockSyncOutcome {
    do {
      guard try await api.state().enabled else {
        lastSync = now()
        return .skipped(.disabled)
      }
      _ = try await api.save(enabled: true, blocks: currentBlocks())
      lastSync = now()
      return .synced
    } catch APIError.signedOut {
      return .skipped(.signedOut)
    } catch {
      return .failed
    }
  }

  private func record(_ outcome: BusyBlockSyncOutcome) -> BusyBlockSyncOutcome {
    lastOutcome = outcome
    return outcome
  }
}
