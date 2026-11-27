import Foundation
import Observation

/// What the in-app upload indicator needs from the capture pipeline. `CaptureEngine` is the real one.
public protocol CaptureJobTracking: Sendable {
  func jobs() async -> [UploadJob]
  /// The full job list, now and after every change.
  func updates() async -> AsyncStream<[UploadJob]>
  func retry(jobID: UUID) async
}

extension CaptureEngine: CaptureJobTracking {}

/// One unfinished capture as the job list shows it.
public struct CaptureJobRow: Identifiable, Equatable, Sendable {
  public let id: UUID
  public let name: String
  public let destinationName: String
  public let stage: UploadStage
  /// The latest problem; also set while a job is waiting to retry on its own.
  public let detail: String?

  init(_ job: UploadJob) {
    id = job.id
    name = job.displayName
    destinationName = job.destination.name
    stage = job.stage
    detail = job.lastError
  }

  public var stageLabel: String {
    switch stage {
    case .queued: "Waiting"
    case .uploading: "Uploading"
    case .registering: "Finishing"
    case .done: "Done"
    case .failed: "Failed"
    }
  }

  public var canRetry: Bool { stage == .failed }
}

/// Drives the compact upload chip and its job list: shows every job that is not `done`, so the background
/// work a finished share composer leaves behind is visible, and a failed one can be retried.
@MainActor
@Observable
public final class CaptureJobsViewModel {
  public private(set) var rows: [CaptureJobRow] = []

  @ObservationIgnored private let tracker: any CaptureJobTracking

  public init(tracker: any CaptureJobTracking) {
    self.tracker = tracker
  }

  public var activeCount: Int { rows.filter { !$0.stage.isTerminal }.count }
  public var failedCount: Int { rows.filter { $0.stage == .failed }.count }
  /// The chip is on screen only while something is uploading or needs a retry.
  public var isVisible: Bool { !rows.isEmpty }
  public var needsAttention: Bool { failedCount > 0 }

  public var chipTitle: String {
    switch (activeCount, failedCount) {
    case (0, 0): ""
    case (0, let failed): failed == 1 ? "Upload failed" : "\(failed) failed"
    case (let active, 0): active == 1 ? "Uploading" : "Uploading \(active)"
    case (let active, let failed): "\(active) uploading, \(failed) failed"
    }
  }

  /// Follows the job list until the calling task is cancelled.
  public func observe() async {
    for await jobs in await tracker.updates() {
      apply(jobs)
    }
  }

  /// A snapshot outside the stream's notifications, e.g. when the app returns to the foreground after the
  /// share extension queued something.
  public func reload() async {
    apply(await tracker.jobs())
  }

  public func retry(_ id: UUID) async {
    await tracker.retry(jobID: id)
  }

  func apply(_ jobs: [UploadJob]) {
    rows = jobs.filter { $0.stage != .done }.map(CaptureJobRow.init)
  }
}
