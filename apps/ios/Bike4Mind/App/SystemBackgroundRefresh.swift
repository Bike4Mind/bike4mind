import B4MKit
import BackgroundTasks
import Foundation

/// `BGTaskScheduler` behind B4MKit's `BackgroundRefreshScheduling`.
struct SystemBackgroundRefreshScheduler: BackgroundRefreshScheduling {
  /// The bundle id differs per signing team, so the identifier is derived from it; AppSupport/Info.plist lists it
  /// the same way.
  static let busyBlockIdentifier: String = {
    guard let bundleID = Bundle.main.bundleIdentifier else { preconditionFailure("The app has no bundle identifier") }
    return BusyBlockBackgroundRefresh.identifier(bundleID: bundleID)
  }()

  func submit(identifier: String, earliestBegin: Date) throws {
    let request = BGAppRefreshTaskRequest(identifier: identifier)
    request.earliestBeginDate = earliestBegin
    try BGTaskScheduler.shared.submit(request)
  }

  func cancel(identifier: String) {
    BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
  }
}

/// `BGAppRefreshTask` behind B4MKit's `BackgroundRefreshTask`.
@MainActor
final class SystemBackgroundRefreshTask: BackgroundRefreshTask {
  private nonisolated(unsafe) let task: BGTask

  init(_ task: BGTask) { self.task = task }

  var expirationHandler: (@Sendable () -> Void)? {
    get { task.expirationHandler }
    set { task.expirationHandler = newValue }
  }

  func setTaskCompleted(success: Bool) {
    task.setTaskCompleted(success: success)
  }
}
