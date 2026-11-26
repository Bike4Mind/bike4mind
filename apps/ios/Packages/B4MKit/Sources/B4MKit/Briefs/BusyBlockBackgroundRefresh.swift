import Foundation
import os

/// Submits background app refresh requests. The `BGTaskScheduler` implementation lives in the app target.
public protocol BackgroundRefreshScheduling: Sendable {
  func submit(identifier: String, earliestBegin: Date) throws
}

/// One system-granted background run. The `BGAppRefreshTask` implementation lives in the app target.
@MainActor
public protocol BackgroundRefreshTask: AnyObject {
  /// Called by the system, on any thread, when the run's time is up.
  var expirationHandler: (@Sendable () -> Void)? { get set }
  func setTaskCompleted(success: Bool)
}

/// Keeps the server's busy blocks current while the app is not opened, so a calendar change made in the background
/// still moves or releases a held brief. Each run re-arms the next one unless syncing has nothing to do until the
/// user acts in the app (feature off, never asked for calendar access, signed out); the next background edge re-arms.
@MainActor
public final class BusyBlockBackgroundRefresh {
  /// Must match the `BGTaskSchedulerPermittedIdentifiers` entry in AppSupport/Info.plist, which is the bundle id
  /// plus this suffix (Tools/check-entitlements-parity.sh enforces it).
  public nonisolated static let identifierSuffix = ".busy-block-refresh"
  /// The earliest begin date asked for; the system decides the real cadence.
  public nonisolated static let interval: TimeInterval = 3600

  public let identifier: String
  private let scheduler: any BackgroundRefreshScheduling
  private let now: @Sendable () -> Date
  private let sync: @MainActor () async -> BusyBlockSyncOutcome
  private let logger = Logger(subsystem: "com.bike4mind.app", category: "busy-blocks")

  public init(
    identifier: String, scheduler: any BackgroundRefreshScheduling, now: @escaping @Sendable () -> Date = { Date() },
    sync: @escaping @MainActor () async -> BusyBlockSyncOutcome
  ) {
    self.identifier = identifier
    self.scheduler = scheduler
    self.now = now
    self.sync = sync
  }

  /// Submit failures (the Simulator, Background App Refresh turned off) are logged and dropped: the foreground
  /// sync still runs.
  public func scheduleNext() {
    do {
      try scheduler.submit(identifier: identifier, earliestBegin: now().addingTimeInterval(Self.interval))
    } catch {
      logger.notice("Busy-block refresh not scheduled: \(String(describing: error), privacy: .public)")
    }
  }

  /// Runs one sync for the task and completes it exactly once: unsuccessfully when the sync failed or the system
  /// expired the run first.
  public func handle(_ task: any BackgroundRefreshTask) {
    let completion = Completion(task: task)
    let run = Task { await sync() }
    task.expirationHandler = { [weak self] in
      run.cancel()
      Task { @MainActor in
        guard completion.complete(success: false) else { return }
        self?.scheduleNext()
      }
    }
    Task {
      let outcome = await run.value
      guard completion.complete(success: outcome != .failed) else { return }
      if Self.rearms(after: outcome) { scheduleNext() }
    }
  }

  static func rearms(after outcome: BusyBlockSyncOutcome) -> Bool {
    switch outcome {
    case .synced, .failed, .skipped(.inFlight), .skipped(.throttled): true
    case .skipped(.disabled), .skipped(.neverAsked), .skipped(.signedOut): false
    }
  }

  @MainActor
  private final class Completion {
    private var task: (any BackgroundRefreshTask)?

    init(task: any BackgroundRefreshTask) { self.task = task }

    /// Returns false when the task was already completed.
    func complete(success: Bool) -> Bool {
      guard let task else { return false }
      self.task = nil
      task.expirationHandler = nil
      task.setTaskCompleted(success: success)
      return true
    }
  }
}
