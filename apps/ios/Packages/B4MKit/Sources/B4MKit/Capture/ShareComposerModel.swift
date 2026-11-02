import Foundation
import Observation

/// Where destinations come from: the user's lakes and sessions.
public protocol DestinationSource: Sendable {
  func lakes() async throws -> [LakeSummary]
  func sessions() async throws -> [SessionSummary]
}

/// Hands items to the upload pipeline. `CaptureEngine` is the real one.
public protocol CaptureSubmitting: Sendable {
  @discardableResult
  func submit(_ items: [ShareItem], to destination: CaptureDestination, note: String?) async throws -> [UploadJob]
}

extension CaptureEngine: CaptureSubmitting {}

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

  private var isRetryableFailure: Bool {
    if case .failed = phase { true } else { false }
  }

  public func load() async {
    phase = .loading
    async let lakeResult = Result { try await source.lakes() }
    async let sessionResult = Result { try await source.sessions() }
    let (lakeOutcome, sessionOutcome) = await (lakeResult, sessionResult)

    var warnings: [String] = []
    switch lakeOutcome {
    case .success(let value): lakes = value
    case .failure: warnings.append("lakes")
    }
    switch sessionOutcome {
    case .success(let value): sessions = value
    case .failure: warnings.append("sessions")
    }
    loadWarning = warnings.isEmpty ? nil : "Couldn't load your \(warnings.joined(separator: " and "))."
    dropStaleDestination(lakesLoaded: !warnings.contains("lakes"), sessionsLoaded: !warnings.contains("sessions"))
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
  }

  public func submit() async {
    guard canSubmit, let destination else { return }
    phase = .submitting
    do {
      let jobs = try await submitter.submit(items, to: destination, note: note)
      store.remember(destination)
      if let failed = jobs.first(where: { $0.stage == .failed }) {
        phase = .failed(failed.lastError ?? "Couldn't send this. Try again.")
      } else {
        phase = .sent
      }
    } catch {
      phase = .failed(CaptureEngine.describe(error))
    }
  }
}
