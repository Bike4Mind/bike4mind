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

/// One bound API and validity check captured synchronously before scheduling or requesting permission.
public struct BusyBlockSession: Sendable {
  let id: UUID
  public let api: any BusyBlocksAPI
  let isCurrent: @MainActor @Sendable () -> Bool

  public init(id: UUID, api: any BusyBlocksAPI, isCurrent: @escaping @MainActor @Sendable () -> Bool) {
    self.id = id
    self.api = api
    self.isCurrent = isCurrent
  }
}

/// Serializes calendar syncs and user saves within their originating account and server.
@MainActor
public final class BusyBlockSyncer {
  public static let minInterval: TimeInterval = 60

  public struct Admission: Sendable {
    let session: BusyBlockSession
    let epoch: Int
  }

  private let reader: any BusyBlockReader
  private let now: @Sendable () -> Date
  private let sessionFactory: @MainActor @Sendable () -> BusyBlockSession
  private let hasSessionFactory: Bool
  private var activeSessionID: UUID?
  private var epoch = 0
  private var lastSync: Date?
  private var current: Task<BusyBlockSyncOutcome, Never>?
  /// Retains an already-sent save until settlement, including across account changes.
  private var sentSave: Task<BusyBlockSyncOutcome, Never>?
  public private(set) var lastOutcome: BusyBlockSyncOutcome?
  /// Calls currently parked behind another sync or save; tests wait on it instead of yielding.
  private(set) var parkedWaits = 0

  public init(
    api: any BusyBlocksAPI, reader: any BusyBlockReader, now: @escaping @Sendable () -> Date = { Date() },
    sessionFactory: (@MainActor @Sendable () -> BusyBlockSession)? = nil
  ) {
    self.reader = reader
    self.now = now
    self.hasSessionFactory = sessionFactory != nil
    let fixed = BusyBlockSession(id: UUID(), api: api, isCurrent: { true })
    self.sessionFactory = sessionFactory ?? { fixed }
  }

  public func captureAdmission() -> Admission {
    let captured = sessionFactory()
    if captured.isCurrent(), activeSessionID != captured.id { adopt(captured.id) }
    return Admission(session: captured, epoch: epoch)
  }

  func isCurrent(_ admission: Admission) -> Bool {
    admission.session.isCurrent() && admission.session.id == activeSessionID && admission.epoch == epoch
  }

  @discardableResult
  public func scheduleSync(force: Bool = false) -> Task<BusyBlockSyncOutcome, Never> {
    let admission = captureAdmission()
    return Task { await sync(force: force, admission: admission) }
  }

  public func currentBlocks() -> [BusyBlock] {
    guard reader.access() == .authorized else { return [] }
    let at = now()
    return BusyBlockFilter.blocks(
      from: reader.events(
        from: at.addingTimeInterval(-BusyBlockFilter.lookBehind), to: at.addingTimeInterval(BusyBlockFilter.lookAhead)))
  }

  @discardableResult
  public func sync(force: Bool = false) async -> BusyBlockSyncOutcome {
    await sync(force: force, admission: captureAdmission())
  }

  @discardableResult
  public func sync(force: Bool = false, admission: Admission) async -> BusyBlockSyncOutcome {
    guard isCurrent(admission) else { return .skipped(.signedOut) }
    guard !Task.isCancelled else { return .failed }
    guard current == nil else { return .skipped(.inFlight) }
    guard reader.access() != .notDetermined else { return record(.skipped(.neverAsked)) }
    if !force, let lastSync, now().timeIntervalSince(lastSync) < Self.minInterval { return .skipped(.throttled) }
    let task = Task { [sentSave] in
      if let sentSave { await waitOut(sentSave) }
      return await perform(admission)
    }
    current = task
    defer { release(task) }
    let outcome = await withTaskCancellationHandler {
      await task.value
    } onCancel: {
      task.cancel()
    }
    return isCurrent(admission) ? record(outcome) : outcome
  }

  public func syncJoiningInFlight() async -> BusyBlockSyncOutcome {
    await syncJoiningInFlight(admission: captureAdmission())
  }

  public func syncJoiningInFlight(admission: Admission) async -> BusyBlockSyncOutcome {
    guard isCurrent(admission) else { return .skipped(.signedOut) }
    if let current { return await current.value }
    return await sync(force: true, admission: admission)
  }

  public func save(enabled: Bool) async throws -> BusyBlocksState {
    try await save(enabled: enabled, admission: captureAdmission())
  }

  public func save(enabled: Bool, admission: Admission) async throws -> BusyBlocksState {
    guard isCurrent(admission) else { throw CancellationError() }
    while let pending = current ?? sentSave {
      await waitOut(pending)
      release(pending)
      if sentSave == pending { sentSave = nil }
      guard isCurrent(admission) else { throw CancellationError() }
    }
    try Task.checkCancellation()
    let api = admission.session.api
    let blocks = enabled ? currentBlocks() : []
    let save = Task { try await api.save(enabled: enabled, blocks: blocks) }
    let task = Task<BusyBlockSyncOutcome, Never> { Self.outcome(of: await save.result) }
    current = task
    sentSave = task
    defer {
      release(task)
      if sentSave == task { sentSave = nil }
    }
    let state = try await save.value
    if isCurrent(admission) { lastOutcome = Self.outcome(of: .success(state)) }
    return state
  }

  private static func outcome(of save: Result<BusyBlocksState, any Error>) -> BusyBlockSyncOutcome {
    switch save {
    case .success(let state): state.enabled ? .synced : .skipped(.disabled)
    case .failure(APIError.signedOut): .skipped(.signedOut)
    case .failure: .failed
    }
  }

  /// A late UI observation must not invalidate work already admitted under that same new session.
  public func sessionDidStart() {
    if hasSessionFactory { _ = captureAdmission() } else { adopt(sessionFactory().id) }
  }

  private func adopt(_ id: UUID) {
    activeSessionID = id
    epoch += 1
    current?.cancel()
    current = nil
    lastOutcome = nil
    lastSync = nil
  }

  private func perform(_ admission: Admission) async -> BusyBlockSyncOutcome {
    guard isCurrent(admission) else { return .skipped(.signedOut) }
    guard !Task.isCancelled else { return .failed }
    do {
      let enabled = try await admission.session.api.state().enabled
      guard isCurrent(admission) else { return .skipped(.signedOut) }
      try Task.checkCancellation()
      guard enabled else {
        lastSync = now()
        return .skipped(.disabled)
      }
      _ = try await admission.session.api.save(enabled: true, blocks: currentBlocks())
      if isCurrent(admission) { lastSync = now() }
      return .synced
    } catch APIError.signedOut { return .skipped(.signedOut) } catch { return .failed }
  }

  private func waitOut(_ task: Task<BusyBlockSyncOutcome, Never>) async {
    parkedWaits += 1
    defer { parkedWaits -= 1 }
    _ = await task.value
  }

  private func release(_ task: Task<BusyBlockSyncOutcome, Never>) {
    if current == task { current = nil }
  }

  private func record(_ outcome: BusyBlockSyncOutcome) -> BusyBlockSyncOutcome {
    lastOutcome = outcome
    return outcome
  }
}
