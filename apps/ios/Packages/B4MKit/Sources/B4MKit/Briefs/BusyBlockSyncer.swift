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
  /// The sync or user save holding the lock; every `sync` caller and `save` take it, so a sync that read the opt-in
  /// before a toggle-off cannot write it back on afterwards.
  private var current: Task<BusyBlockSyncOutcome, Never>?
  /// A user save already sent; outlives `sessionDidStart` so the next session's sync cannot read before it lands.
  private var sentSave: Task<BusyBlockSyncOutcome, Never>?
  /// Bumped by `sessionDidStart`: work begun under an earlier session must not write to or throttle the new one.
  private var session = 0
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
    let startedIn = session
    let task = Task { [sentSave] in
      _ = await sentSave?.value
      return await perform(in: startedIn)
    }
    current = task
    defer { release(task) }
    let outcome = await withTaskCancellationHandler {
      await task.value
    } onCancel: {
      task.cancel()
    }
    return session == startedIn ? record(outcome) : outcome
  }

  /// A forced sync, or the outcome of the one already running, so a caller that must report success waits for it.
  /// Cancelling the caller does not cancel a sync it joined.
  public func syncJoiningInFlight() async -> BusyBlockSyncOutcome {
    if let current { return await current.value }
    return await sync(force: true)
  }

  /// Saves the user's opt-in once any sync or save in flight has finished: turning it on pushes the current blocks,
  /// turning it off clears them. A save queued under an earlier session throws `CancellationError` unsent.
  public func save(enabled: Bool) async throws -> BusyBlocksState {
    let startedIn = session
    // A finished task is released here too: its owner may not have resumed yet, and re-awaiting it would spin.
    // A save still in flight from an earlier session is awaited as well, so two writes never race.
    while let pending = current ?? sentSave {
      _ = await pending.value
      release(pending)
      if sentSave == pending { sentSave = nil }
    }
    guard session == startedIn else { throw CancellationError() }
    let save = Task { try await api.save(enabled: enabled, blocks: enabled ? currentBlocks() : []) }
    let task = Task<BusyBlockSyncOutcome, Never> { Self.outcome(of: await save.result) }
    current = task
    sentSave = task
    defer {
      release(task)
      if sentSave == task { sentSave = nil }
    }
    let state = try await save.value
    // No suspension between the check and the write, so a session started meanwhile never gets this outcome.
    if session == startedIn { lastOutcome = Self.outcome(of: .success(state)) }
    return state
  }

  private static func outcome(of save: Result<BusyBlocksState, any Error>) -> BusyBlockSyncOutcome {
    switch save {
    case .success(let state): state.enabled ? .synced : .skipped(.disabled)
    case .failure(APIError.signedOut): .skipped(.signedOut)
    case .failure: .failed
    }
  }

  /// Forgets the last outcome and throttle at a sign-in: a signed-out or opted-out result belongs to the
  /// previous session and would otherwise keep the background edge from re-arming for the new one. A sync still
  /// running for the previous session is cancelled and stops holding the lock, so the new session's first sync is
  /// not skipped. A user save already sent is not cancelled: `sentSave` still holds the next sync until it lands.
  public func sessionDidStart() {
    session += 1
    current?.cancel()
    current = nil
    lastOutcome = nil
    lastSync = nil
  }

  private func perform(in startedIn: Int) async -> BusyBlockSyncOutcome {
    do {
      let enabled = try await api.state().enabled
      // The API resolves the token per request, so a write now would land on whoever signed in since.
      guard session == startedIn else { return .skipped(.signedOut) }
      guard enabled else {
        lastSync = now()
        return .skipped(.disabled)
      }
      _ = try await api.save(enabled: true, blocks: currentBlocks())
      if session == startedIn { lastSync = now() }
      return .synced
    } catch APIError.signedOut {
      return .skipped(.signedOut)
    } catch {
      return .failed
    }
  }

  private func release(_ task: Task<BusyBlockSyncOutcome, Never>) {
    if current == task { current = nil }
  }

  private func record(_ outcome: BusyBlockSyncOutcome) -> BusyBlockSyncOutcome {
    lastOutcome = outcome
    return outcome
  }
}
