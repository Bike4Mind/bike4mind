import Foundation
import Observation

/// Where destinations come from: the user's lakes and sessions.
public protocol DestinationSource: Sendable {
  func lakes() async throws -> [LakeSummary]
  func sessions() async throws -> [SessionSummary]
}

/// Hands items to the upload pipeline. `CaptureEngine` is the real one.
public protocol CaptureSubmitting: Sendable {
  /// One job per item, in item order.
  @discardableResult
  func submit(_ items: [ShareItem], to destination: CaptureDestination, note: String?) async throws -> [UploadJob]
  /// Re-runs a failed job in place, keeping what it already knows (a turn that may have been sent is
  /// reconciled rather than re-posted).
  func retry(jobID: UUID) async
  func discard(jobID: UUID) async
  func jobs() async -> [UploadJob]
}

extension CaptureEngine: CaptureSubmitting {}

/// `Result.init(catching:)` only takes a synchronous closure, so async loads that must not throw
/// (each failure becomes a warning, not an abort) are wrapped here instead.
private func catchingAsync<Success: Sendable>(
  _ body: () async throws -> Success
) async -> Result<Success, any Error> {
  do {
    return .success(try await body())
  } catch {
    return .failure(error)
  }
}

public struct RemoteDestinationSource: DestinationSource {
  private let capture: any CaptureAPI
  private let api: any B4MAPI
  private let pageSize: Int
  /// Pages are bounded so a huge account cannot turn a share sheet into a crawl.
  private let maxPages: Int

  public init(capture: any CaptureAPI, api: any B4MAPI, pageSize: Int = 50, maxPages: Int = 4) {
    self.capture = capture
    self.api = api
    self.pageSize = pageSize
    self.maxPages = maxPages
  }

  public func lakes() async throws -> [LakeSummary] {
    var all: [LakeSummary] = []
    var cursor: String?
    for _ in 0..<maxPages {
      let page = try await capture.listLakes(cursor: cursor, limit: pageSize)
      all += page.items.filter { !$0.isBuiltIn }
      guard let next = page.nextCursor else { break }
      cursor = next
    }
    return all
  }

  public func sessions() async throws -> [SessionSummary] {
    try await api.listSessions(cursor: nil, limit: pageSize).items
  }
}

/// The composer behind the share sheet and the in-app capture sheet: choose a destination, add a note, send.
@MainActor
@Observable
public final class ShareComposerModel {
  public enum Phase: Equatable {
    case loading
    case ready
    case submitting
    case sent
    case failed(String)
  }

  public private(set) var phase: Phase = .loading
  public private(set) var lakes: [LakeSummary] = []
  public private(set) var sessions: [SessionSummary] = []
  /// Set when a destination list could not be loaded; the other list is still usable.
  public private(set) var loadWarning: String?
  public var destination: CaptureDestination?
  public var note = ""
  public private(set) var items: [ShareItem]

  /// After a partly failed send: the failed job behind each entry of `items` (which then holds only what did
  /// not go through), and what that send was addressed with. Sending again to the same place retries these
  /// jobs, so what already went through is never sent twice.
  @ObservationIgnored private var failedJobIDs: [UUID] = []
  @ObservationIgnored private var failedSend: (destination: CaptureDestination, note: String)?
  @ObservationIgnored private let source: any DestinationSource
  @ObservationIgnored private let submitter: any CaptureSubmitting
  @ObservationIgnored private let store: any DestinationStore

  public init(
    items: [ShareItem], source: any DestinationSource, submitter: any CaptureSubmitting,
    store: any DestinationStore
  ) {
    self.items = items
    self.source = source
    self.submitter = submitter
    self.store = store
    destination = store.lastDestination()
  }

  public var canSubmit: Bool {
    destination != nil && !items.isEmpty && (phase == .ready || isRetryableFailure)
  }

  /// The top-left button: once the send went out there is nothing left to cancel.
  public var dismissButtonTitle: String { phase == .sent ? "Done" : "Cancel" }

  private var isRetryableFailure: Bool {
    if case .failed = phase { true } else { false }
  }

  public func load() async {
    phase = .loading
    async let lakeResult = catchingAsync { try await source.lakes() }
    async let sessionResult = catchingAsync { try await source.sessions() }
    let (lakeOutcome, sessionOutcome) = await (lakeResult, sessionResult)

    var warnings: [String] = []
    switch lakeOutcome {
    case .success(let value): lakes = value
    case .failure: warnings.append("lakes")
    }
    switch sessionOutcome {
    case .success(let value): sessions = value
    case .failure: warnings.append("notebooks")
    }
    loadWarning = warnings.isEmpty ? nil : "Couldn't load your \(warnings.joined(separator: " and "))."
    dropStaleDestination(lakesLoaded: !warnings.contains("lakes"), sessionsLoaded: !warnings.contains("notebooks"))
    phase = .ready
  }

  /// A remembered destination that was deleted since is dropped, but only when its list actually loaded.
  private func dropStaleDestination(lakesLoaded: Bool, sessionsLoaded: Bool) {
    switch destination {
    case .lake(let id, _) where lakesLoaded && !lakes.contains(where: { $0.id == id }):
      destination = nil
    case .session(let id, _) where sessionsLoaded && !sessions.contains(where: { $0.id == id }):
      destination = nil
    default:
      break
    }
  }

  public func choose(_ destination: CaptureDestination) {
    self.destination = destination
  }

  public func remove(at index: Int) {
    guard items.indices.contains(index) else { return }
    items.remove(at: index)
    // Only while `items` is exactly the failed items does an index name a job.
    if failedJobIDs.count == items.count + 1 {
      // The user dropped an item that failed: its job must not linger in the queue and resurface later.
      let jobID = failedJobIDs.remove(at: index)
      let submitter = submitter
      Task { await submitter.discard(jobID: jobID) }
    }
  }

  public func submit() async {
    guard canSubmit, let destination else { return }
    phase = .submitting
    let sentItems = items
    do {
      let jobs: [UploadJob?]
      if let failedSend, failedSend.destination == destination, failedSend.note == note, !failedJobIDs.isEmpty {
        jobs = await retryFailedJobs()
      } else {
        // A new destination or note means a new send; the old attempt's failed jobs go with it.
        await discardFailedJobs()
        jobs = try await submitter.submit(sentItems, to: destination, note: note)
      }
      store.remember(destination)
      settle(sentItems: sentItems, jobs: jobs, destination: destination)
    } catch {
      phase = .failed(CaptureEngine.describe(error))
    }
  }

  private func retryFailedJobs() async -> [UploadJob?] {
    let jobIDs = failedJobIDs
    for jobID in jobIDs { await submitter.retry(jobID: jobID) }
    let current = Dictionary(await submitter.jobs().map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    return jobIDs.map { current[$0] }
  }

  private func discardFailedJobs() async {
    for jobID in failedJobIDs { await submitter.discard(jobID: jobID) }
    failedJobIDs = []
    failedSend = nil
  }

  /// Keeps only the items whose job failed, so the next Send cannot repeat what already went through.
  /// A job that is gone from the queue is not failed: there is nothing left to retry.
  private func settle(sentItems: [ShareItem], jobs: [UploadJob?], destination: CaptureDestination) {
    let failedJobs = jobs.compactMap { $0 }.filter { $0.stage == .failed }
    guard let firstFailure = failedJobs.first else {
      failedJobIDs = []
      failedSend = nil
      phase = .sent
      return
    }
    if jobs.count == sentItems.count {
      let failedIndices = jobs.indices.filter { jobs[$0]?.stage == .failed }
      items = failedIndices.map { sentItems[$0] }
    } else {
      // Breaks the one-job-per-item contract. Keep every item (none can be matched to its job) and still
      // retry only the failed jobs, which never re-sends a delivered item.
      assertionFailure("submitter returned \(jobs.count) jobs for \(sentItems.count) items")
    }
    failedJobIDs = failedJobs.map(\.id)
    failedSend = (destination, note)
    phase = .failed(firstFailure.lastError ?? "Couldn't send this. Try again.")
  }
}
