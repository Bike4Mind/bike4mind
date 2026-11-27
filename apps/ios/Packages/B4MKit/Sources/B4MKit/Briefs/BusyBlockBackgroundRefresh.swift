import Foundation
import os

/// Submits background app refresh requests. The `BGTaskScheduler` implementation lives in the app target.
public protocol BackgroundRefreshScheduling: Sendable {
  func submit(identifier: String, earliestBegin: Date) throws
  func cancel(identifier: String)
}

/// One system-granted background run. The `BGAppRefreshTask` implementation lives in the app target.
@MainActor
public protocol BackgroundRefreshTask: AnyObject {
  /// Called by the system, on any thread, when the run's time is up.
  var expirationHandler: (@Sendable () -> Void)? { get set }
  func setTaskCompleted(success: Bool)
}

/// Keeps the server's busy blocks current while the app is not opened, so a calendar change made in the background
/// still moves or releases a held brief. Each run re-arms the next one. A run with the feature off re-arms at
/// `disabledInterval`, since another device can turn the server opt-in on; one that can only change in this app
/// (calendar access never asked, signed out) does not re-arm, and the next background edge decides again.
@MainActor
public final class BusyBlockBackgroundRefresh {
  /// Must match the `BGTaskSchedulerPermittedIdentifiers` entry in AppSupport/Info.plist, which is the bundle id
  /// plus this suffix (Tools/check-entitlements-parity.sh enforces it).
  public nonisolated static let identifierSuffix = ".busy-block-refresh"

  /// The task identifier for an app with this bundle id.
  public nonisolated static func identifier(bundleID: String) -> String { bundleID + identifierSuffix }
  /// The earliest begin date asked for; the system decides the real cadence.
  public nonisolated static let interval: TimeInterval = 3600
  /// The earliest begin date while the server opt-in is off: cheap on refresh budget, still picks up a remote opt-in.
  public nonisolated static let disabledInterval: TimeInterval = 6 * 3600

  public let identifier: String
  private let scheduler: any BackgroundRefreshScheduling
  private let now: @Sendable () -> Date
  public typealias PreparedSync = @MainActor @Sendable () async -> BusyBlockSyncOutcome
  private let prepareSync: @MainActor () -> PreparedSync
  private let logger = Logger(subsystem: "com.bike4mind.app", category: "busy-blocks")

  public init(
    identifier: String, scheduler: any BackgroundRefreshScheduling, now: @escaping @Sendable () -> Date = { Date() },
    sync: @escaping @MainActor () async -> BusyBlockSyncOutcome
  ) {
    self.identifier = identifier
    self.scheduler = scheduler
    self.now = now
    self.prepareSync = { { await sync() } }
  }

  public init(
    identifier: String, scheduler: any BackgroundRefreshScheduling, now: @escaping @Sendable () -> Date = { Date() },
    prepareSync: @escaping @MainActor () -> PreparedSync
  ) {
    self.identifier = identifier
    self.scheduler = scheduler
    self.now = now
    self.prepareSync = prepareSync
  }

  /// Submits the next run for the last known sync outcome (nil when unknown). Submit failures (the Simulator,
  /// Background App Refresh turned off) are logged and dropped: the foreground sync still runs.
  public func scheduleNext(after outcome: BusyBlockSyncOutcome? = nil) {
    guard let delay = Self.delay(after: outcome) else { return }
    do {
      try scheduler.submit(identifier: identifier, earliestBegin: now().addingTimeInterval(delay))
    } catch {
      logger.notice("Busy-block refresh not scheduled: \(String(describing: error), privacy: .public)")
    }
  }

  /// Drops the pending request at sign-out, so no run fires for an account that is gone.
  public func cancelPending() {
    scheduler.cancel(identifier: identifier)
  }

  /// Runs one sync for the task and completes it exactly once: unsuccessfully when the sync failed or the system
  /// expired the run first.
  public func handle(_ task: any BackgroundRefreshTask) {
    let completion = Completion(task: task)
    let sync = prepareSync()
    let run = Task { await sync() }
    task.expirationHandler = { [weak self] in
      run.cancel()
      Task { @MainActor in
        guard !completion.isCompleted else { return }
        self?.scheduleNext()
        completion.complete(success: false)
      }
    }
    Task {
      let outcome = await run.value
      guard !completion.isCompleted else { return }
      // Submit before completing: the system may suspend the app as soon as the task is completed.
      scheduleNext(after: outcome)
      completion.complete(success: outcome != .failed)
    }
  }

  /// Seconds until the next run, or nil when only the user acting in this app can give it something to do.
  static func delay(after outcome: BusyBlockSyncOutcome?) -> TimeInterval? {
    switch outcome {
    case nil, .synced, .failed, .skipped(.inFlight), .skipped(.throttled): interval
    case .skipped(.disabled): disabledInterval
    case .skipped(.neverAsked), .skipped(.signedOut): nil
    }
  }

  @MainActor
  private final class Completion {
    private var task: (any BackgroundRefreshTask)?

    init(task: any BackgroundRefreshTask) { self.task = task }

    var isCompleted: Bool { task == nil }

    /// A no-op once the task was already completed.
    func complete(success: Bool) {
      guard let task else { return }
      self.task = nil
      task.expirationHandler = nil
      task.setTaskCompleted(success: success)
    }
  }
}
