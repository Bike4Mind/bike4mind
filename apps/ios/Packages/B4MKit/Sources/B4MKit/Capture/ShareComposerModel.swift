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

/// What the assistant is asked to handle: the user's one-line intent plus the shared item.
public struct DelegationRequest: Equatable, Sendable {
  public let intent: String
  public let url: URL?
  public let text: String?
  public let fileIDs: [String]

  public init(intent: String, url: URL?, text: String?, fileIDs: [String]) {
    self.intent = intent
    self.url = url
    self.text = text
    self.fileIDs = fileIDs
  }
}

/// Hands a shared item to the user's assistant. `CaptureClient` is the real one.
public protocol DelegationSubmitting: Sendable {
  func delegate(_ request: DelegationRequest) async throws
}

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
      all += page.items.filter { !$0.isBuiltIn && $0.canManage }
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
  /// Optional one-liner; when set, the assistant is asked to handle the shared item after the send.
  public var intent = ""
  public private(set) var items: [ShareItem]

  /// After a partly failed send: the failed job behind each entry of `items` (which then holds only what did
  /// not go through), and what that send was addressed with. Sending again to the same place retries these
  /// jobs, so what already went through is never sent twice.
  @ObservationIgnored private var failedJobIDs: [UUID] = []
  @ObservationIgnored private var failedSend: (destination: CaptureDestination, note: String)?
  /// The items and uploaded file ids of the current send, which the delegation is built from (a retry only
  /// sees the items that failed).
  @ObservationIgnored private var sendContext: (items: [ShareItem], fileIDs: [String]) = ([], [])
  /// A delegation whose POST failed after the items were delivered; the next Send re-posts only this.
  @ObservationIgnored private var pendingDelegation: DelegationRequest?
  @ObservationIgnored private let delegator: (any DelegationSubmitting)?
  @ObservationIgnored private let source: any DestinationSource
  @ObservationIgnored private let submitter: any CaptureSubmitting
  @ObservationIgnored private let store: any DestinationStore

  public init(
    items: [ShareItem], source: any DestinationSource, submitter: any CaptureSubmitting,
    store: any DestinationStore, delegator: (any DelegationSubmitting)? = nil
  ) {
    self.delegator = delegator
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
    if let pendingDelegation {
      // The retry carries the Assistant field as it is now, so an edit is honoured and clearing it cancels.
      let intent = Self.normalizedIntent(intent)
      guard !intent.isEmpty else {
        self.pendingDelegation = nil
        phase = .sent
        return
      }
      await postDelegation(
        DelegationRequest(
          intent: intent, url: pendingDelegation.url, text: pendingDelegation.text,
          fileIDs: pendingDelegation.fileIDs))
      return
    }
    let sentItems = items
    do {
      let jobs: [UploadJob?]
      if let failedSend, failedSend.destination == destination, failedSend.note == note, !failedJobIDs.isEmpty {
        jobs = await retryFailedJobs()
      } else {
        // A new destination or note means a new send; the old attempt's failed jobs go with it.
        await discardFailedJobs()
        sendContext = (sentItems, [])
        jobs = try await submitter.submit(sentItems, to: destination, note: note)
      }
      store.remember(destination)
      settle(sentItems: sentItems, jobs: jobs, destination: destination)
      if phase == .sent { await delegateIfAsked() }
    } catch {
      phase = .failed(CaptureEngine.describe(error))
    }
  }

  private func delegateIfAsked() async {
    let intent = Self.normalizedIntent(intent)
    guard delegator != nil, !intent.isEmpty else { return }
    let items = sendContext.items
    let texts = items.compactMap { item -> String? in
      if case .text(let text) = item { text } else { nil }
    }
    // The API takes only an http(s) link within its length cap; any other link would be refused on every retry.
    let url = items.lazy.compactMap { item -> URL? in
      guard case .url(let url) = item, ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
        url.host?.isEmpty == false, url.absoluteString.utf16.count <= Self.maxDelegatedURL
      else { return nil }
      return url
    }.first
    let text = texts.isEmpty ? nil : Self.clipped(texts.joined(separator: "\n\n"), to: Self.maxDelegatedText)
    let fileIDs = Array(sendContext.fileIDs.prefix(Self.maxDelegatedFiles))
    guard url != nil || text != nil || !fileIDs.isEmpty else { return }
    await postDelegation(DelegationRequest(intent: intent, url: url, text: text, fileIDs: fileIDs))
  }

  /// One line within the server's cap: the API refuses a newline or a longer intent.
  private static func normalizedIntent(_ raw: String) -> String {
    let line = raw.split(whereSeparator: \.isNewline).joined(separator: " ").trimmingCharacters(in: .whitespaces)
    return clipped(line, to: maxIntent)
  }

  private func postDelegation(_ request: DelegationRequest) async {
    guard let delegator else { return }
    // Not `.sent` while the POST is in flight: that would show Done, and Done in the share extension
    // tears the process down mid-request.
    phase = .submitting
    do {
      try await delegator.delegate(request)
      pendingDelegation = nil
      phase = .sent
    } catch {
      pendingDelegation = request
      let reason = (error as? CaptureError).flatMap { error -> String? in
        if case .rejected(let message) = error { message } else { nil }
      }
      phase = .failed(reason ?? "Saved, but couldn't hand it to your assistant. Try again.")
    }
  }

  private static let maxIntent = 200
  private static let maxDelegatedText = 8_000
  private static let maxDelegatedFiles = 10
  private static let maxDelegatedURL = 2_048

  /// The server caps count UTF-16 code units, not characters, so an emoji-heavy prefix could still be refused.
  private static func clipped(_ text: String, to maxUnits: Int) -> String {
    var units = 0
    var end = text.startIndex
    for index in text.indices {
      units += text[index].utf16.count
      if units > maxUnits { break }
      end = text.index(after: index)
    }
    return String(text[..<end])
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
    for case let job? in jobs where job.stage != .failed {
      if case .file = job.payload, let id = job.ticket?.fileID, !sendContext.fileIDs.contains(id) {
        sendContext.fileIDs.append(id)
      }
    }
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
