import Foundation
import Observation

/// Drives the Artifacts list: the feature gate, the first page, and cursor pagination.
@MainActor
@Observable
public final class ArtifactsViewModel {
  /// `nil` until the feature flag is known; the list stays hidden unless it is `true`.
  public private(set) var isFeatureEnabled: Bool?
  public private(set) var artifacts: [ArtifactSummary] = []
  public private(set) var state: ListLoadState = .idle
  public private(set) var isLoadingMore = false
  /// A failed "load more" is reported apart from `state` so rows already shown stay put.
  public private(set) var loadMoreError: APIError?

  @ObservationIgnored private var pages = PageAccumulator<ArtifactSummary>()
  @ObservationIgnored private let api: any ArtifactsAPI
  @ObservationIgnored private let pageSize: Int
  @ObservationIgnored private var refreshTask: Task<Void, Never>?

  public init(api: any ArtifactsAPI, pageSize: Int = 25) {
    self.api = api
    self.pageSize = pageSize
  }

  public var hasMore: Bool { pages.hasMore }

  public func load() async {
    await refresh()
  }

  public func refresh() async {
    if let refreshTask { return await refreshTask.value }
    let task = Task { await self.performRefresh() }
    refreshTask = task
    await task.value
  }

  private func performRefresh() async {
    defer { refreshTask = nil }
    if artifacts.isEmpty { state = .loading }
    do {
      if isFeatureEnabled != true { isFeatureEnabled = try await api.artifactsEnabled() }
      guard isFeatureEnabled == true else {
        state = .loaded
        return
      }
      let page = try await api.listArtifacts(cursor: nil, limit: pageSize)
      pages.replace(with: page)
      artifacts = pages.items
      loadMoreError = nil
      state = .loaded
    } catch {
      state = .failed(Self.apiError(from: error))
    }
  }

  /// Call as each row appears; fetches the next page when the row is near the end of what is loaded.
  public func loadMoreIfNeeded(currentItem: ArtifactSummary) async {
    guard let index = artifacts.firstIndex(where: { $0.id == currentItem.id }), index >= artifacts.count - 5 else {
      return
    }
    await loadMore()
  }

  public func loadMore() async {
    guard let cursor = pages.nextCursor, !isLoadingMore, refreshTask == nil else { return }
    isLoadingMore = true
    defer { isLoadingMore = false }
    do {
      let page = try await api.listArtifacts(cursor: cursor, limit: pageSize)
      pages.append(page)
      artifacts = pages.items
      loadMoreError = nil
    } catch is CancellationError {
      return
    } catch {
      loadMoreError = Self.apiError(from: error)
    }
  }

  private static func apiError(from error: any Error) -> APIError {
    (error as? APIError) ?? .malformedResponse
  }
}

/// Loads one artifact's content for the detail screen.
@MainActor
@Observable
public final class ArtifactDetailViewModel {
  public enum Phase: Equatable, Sendable {
    case loading
    case loaded(Artifact)
    case failed(APIError)
  }

  public private(set) var phase: Phase = .loading
  public let summary: ArtifactSummary

  @ObservationIgnored private let api: any ArtifactsAPI

  public init(summary: ArtifactSummary, api: any ArtifactsAPI) {
    self.summary = summary
    self.api = api
  }

  public func load() async {
    if case .loaded = phase {} else { phase = .loading }
    do {
      phase = .loaded(try await api.artifact(id: summary.id))
    } catch is CancellationError {
      return
    } catch {
      phase = .failed((error as? APIError) ?? .malformedResponse)
    }
  }
}
