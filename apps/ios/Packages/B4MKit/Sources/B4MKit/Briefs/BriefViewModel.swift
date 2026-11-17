import Foundation
import Observation

/// Loads and composes the brief screen's content. With an id (a push tap) it shows that brief; without one
/// (the drawer row) it shows the latest. A brief still composing is polled until it settles.
@MainActor
@Observable
public final class BriefViewModel {
  public enum State: Equatable, Sendable {
    case loading
    case loaded
    case failed(APIError)
  }

  public typealias Sleep = @Sendable (Duration) async throws -> Void

  public private(set) var state: State = .loading
  /// The brief on screen; `nil` after a load that found none (the empty state).
  public private(set) var brief: Brief?
  /// Whether a compose request or a poll of a composing brief is in flight.
  public private(set) var isComposing = false
  /// The poll gave up waiting. The brief may still finish: pulling to refresh looks again.
  public private(set) var composeTimedOut = false

  @ObservationIgnored private let api: any BriefAPI
  @ObservationIgnored private let briefID: String?
  @ObservationIgnored private let sleep: Sleep
  @ObservationIgnored private let pollInterval: Duration
  @ObservationIgnored private let maxPolls: Int
  @ObservationIgnored private var composeTask: Task<Void, Never>?

  public init(
    api: any BriefAPI, briefID: String? = nil, pollInterval: Duration = .seconds(2),
    pollWindow: Duration = .seconds(90),
    sleep: @escaping Sleep = { try await Task.sleep(for: $0) }
  ) {
    self.api = api
    self.briefID = briefID
    self.pollInterval = pollInterval
    self.sleep = sleep
    maxPolls = max(1, Int(pollWindow / pollInterval))
  }

  /// First load. Does not clear what is on screen if it fails after a brief arrived.
  public func load() async {
    if brief == nil { state = .loading }
    await fetch()
    await pollWhileComposing()
  }

  public func refresh() async {
    await fetch()
    await pollWhileComposing()
  }

  /// Asks the server to compose a fresh brief, then polls until it is ready or failed.
  public func composeNow() async {
    guard !isComposing else { return }
    isComposing = true
    composeTimedOut = false
    do {
      brief = try await api.compose()
      state = .loaded
    } catch {
      isComposing = false
      state = .failed(Self.apiError(from: error))
      return
    }
    await pollWhileComposing()
  }

  /// `composeNow()` as a task the view can cancel when it disappears.
  public func startCompose() {
    composeTask?.cancel()
    composeTask = Task { await composeNow() }
  }

  public func cancel() {
    composeTask?.cancel()
    composeTask = nil
  }

  private func fetch() async {
    do {
      if let briefID {
        brief = try await api.brief(id: briefID)
      } else {
        let briefs = try await api.list()
        brief = briefs.first { $0.status == .ready } ?? briefs.first
      }
      state = .loaded
    } catch is CancellationError {
      return
    } catch {
      state = .failed(Self.apiError(from: error))
    }
  }

  private func pollWhileComposing() async {
    guard brief?.status == .composing, case .loaded = state else {
      isComposing = false
      return
    }
    isComposing = true
    defer { isComposing = false }
    for _ in 0..<maxPolls {
      do {
        try await sleep(pollInterval)
        guard let current = brief else { return }
        brief = try await api.brief(id: current.id)
      } catch is CancellationError {
        return
      } catch {
        state = .failed(Self.apiError(from: error))
        return
      }
      if brief?.status != .composing { return }
    }
    composeTimedOut = true
  }

  private static func apiError(from error: any Error) -> APIError {
    error as? APIError ?? .malformedResponse
  }
}
