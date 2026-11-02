import Foundation
import Observation

/// Drives the sessions list: cache-first render, refresh from the server, cursor pagination.
@MainActor
@Observable
public final class SessionsViewModel {
  public private(set) var sessions: [SessionSummary] = []
  public private(set) var state: ListLoadState = .idle
  public private(set) var isLoadingMore = false
  /// A failed "load more" is reported apart from `state` so rows already shown stay put.
  public private(set) var loadMoreError: APIError?
  /// `true` while the rows on screen came from disk and have not been confirmed by the server yet.
  public private(set) var isShowingCachedRows = false

  @ObservationIgnored private var pages = PageAccumulator<SessionSummary>()
  @ObservationIgnored private let api: any B4MAPI
  @ObservationIgnored private let cache: any SessionListCache
  @ObservationIgnored private let pageSize: Int
  @ObservationIgnored private var isRefreshing = false

  public init(api: any B4MAPI, cache: any SessionListCache, pageSize: Int = 25) {
    self.api = api
    self.cache = cache
    self.pageSize = pageSize
  }

  public var hasMore: Bool { pages.hasMore }

  /// First appearance: paint cached rows immediately, then refresh.
  public func load() async {
    if sessions.isEmpty, let cached = await cache.load(), !cached.isEmpty {
      sessions = cached
      isShowingCachedRows = true
    }
    await refresh()
  }

  public func refresh() async {
    guard !isRefreshing else { return }
    isRefreshing = true
    defer { isRefreshing = false }

    if sessions.isEmpty { state = .loading }
    do {
      let page = try await api.listSessions(cursor: nil, limit: pageSize)
      pages.replace(with: page)
      sessions = pages.items
      isShowingCachedRows = false
      loadMoreError = nil
      state = .loaded
      await cache.save(pages.items)
    } catch {
      state = .failed(Self.apiError(from: error))
    }
  }

  /// Call as each row appears; fetches the next page when the row is near the end of what is loaded.
  public func loadMoreIfNeeded(currentItem: SessionSummary) async {
    guard let index = sessions.firstIndex(where: { $0.id == currentItem.id }),
      index >= sessions.count - 5
    else { return }
    await loadMore()
  }

  public func loadMore() async {
    guard let cursor = pages.nextCursor, !isLoadingMore, !isRefreshing, !isShowingCachedRows else { return }
    isLoadingMore = true
    defer { isLoadingMore = false }
    do {
      let page = try await api.listSessions(cursor: cursor, limit: pageSize)
      pages.append(page)
      sessions = pages.items
      loadMoreError = nil
    } catch {
      loadMoreError = Self.apiError(from: error)
    }
  }

  private static func apiError(from error: any Error) -> APIError {
    (error as? APIError) ?? .malformedResponse
  }
}
