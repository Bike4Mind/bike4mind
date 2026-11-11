import Foundation
import Observation

/// Drives the Studio gallery: a newest-first grid of generated files, filterable by kind, paged by number.
@MainActor
@Observable
public final class MediaGalleryViewModel {
  public private(set) var items: [MediaItem] = []
  public private(set) var state: ListLoadState = .idle
  public private(set) var isLoadingMore = false
  public private(set) var loadMoreError: APIError?
  public private(set) var kind: MediaKind?

  @ObservationIgnored private let api: any MediaAPI
  @ObservationIgnored private let pageSize: Int
  @ObservationIgnored private let onLatestImage: (@Sendable (MediaItem) async -> Void)?
  @ObservationIgnored private var nextPage = 1
  @ObservationIgnored private var hasMore = false
  @ObservationIgnored private var isRefreshing = false
  /// Bumped on every filter change so a slow response for the old filter cannot overwrite the new one.
  @ObservationIgnored private var generation = 0

  /// - Parameter onLatestImage: told about the newest image whenever a refresh lands its first page;
  ///   the app uses it to keep the "Latest generation" widget current.
  public init(
    api: any MediaAPI, pageSize: Int = 30, onLatestImage: (@Sendable (MediaItem) async -> Void)? = nil
  ) {
    self.api = api
    self.pageSize = pageSize
    self.onLatestImage = onLatestImage
  }

  public var canLoadMore: Bool { hasMore && !isLoadingMore && !isRefreshing }

  public func load() async {
    guard state == .idle else { return }
    await refresh()
  }

  public func select(kind: MediaKind?) async {
    guard kind != self.kind else { return }
    self.kind = kind
    generation += 1
    items = []
    hasMore = false
    nextPage = 1
    state = .idle
    isRefreshing = false
    await refresh()
  }

  public func refresh() async {
    guard !isRefreshing else { return }
    isRefreshing = true
    let requested = generation
    defer { if requested == generation { isRefreshing = false } }

    if items.isEmpty { state = .loading }
    do {
      let page = try await api.listMedia(kind: kind, page: 1, limit: pageSize)
      guard requested == generation else { return }
      items = page.items
      hasMore = page.hasMore
      nextPage = 2
      loadMoreError = nil
      state = .loaded
      if kind == nil || kind == .image, let latest = page.items.first(where: { $0.kind == .image }) {
        await onLatestImage?(latest)
      }
    } catch {
      guard requested == generation else { return }
      state = .failed((error as? APIError) ?? .malformedResponse)
    }
  }

  /// Call as each cell appears; fetches the next page when the cell is near the end of what is loaded.
  public func loadMoreIfNeeded(currentItem: MediaItem) async {
    guard let index = items.firstIndex(where: { $0.id == currentItem.id }), index >= items.count - 6 else { return }
    await loadMore()
  }

  public func loadMore() async {
    guard canLoadMore else { return }
    isLoadingMore = true
    let requested = generation
    defer { isLoadingMore = false }
    do {
      let page = try await api.listMedia(kind: kind, page: nextPage, limit: pageSize)
      guard requested == generation else { return }
      let known = Set(items.map(\.id))
      items += page.items.filter { !known.contains($0.id) }
      hasMore = page.hasMore
      nextPage += 1
      loadMoreError = nil
    } catch {
      guard requested == generation else { return }
      loadMoreError = (error as? APIError) ?? .malformedResponse
    }
  }
}

/// One item on screen. Owns the "presigned URLs are short-lived" policy: refetch the detail before
/// playback when the URL is near expiry, and once more when playback fails, never in a loop.
@MainActor
@Observable
public final class MediaDetailViewModel {
  public enum State: Equatable, Sendable {
    case ready
    case refreshing
    case failed(APIError)
  }

  public private(set) var item: MediaItem
  public private(set) var state: State = .ready

  /// A failed playback triggers at most this many refetches in a row; `playbackSucceeded()` resets the count.
  public static let maxConsecutiveRefreshes = 2

  @ObservationIgnored private let api: any MediaAPI
  @ObservationIgnored private let now: @Sendable () -> Date
  @ObservationIgnored private var consecutiveRefreshes = 0

  public init(item: MediaItem, api: any MediaAPI, now: @escaping @Sendable () -> Date = Date.init) {
    self.item = item
    self.api = api
    self.now = now
  }

  /// Fetches a fresh URL when the one in hand is missing or about to lapse.
  public func prepare() async {
    guard !item.isURLUsable(at: now()) else { return }
    await refetch()
  }

  /// The loader or player could not use the URL. Returns whether a fresh URL was fetched (so the caller
  /// should retry once); `false` means retries are exhausted or the refetch failed.
  @discardableResult
  public func playbackFailed() async -> Bool {
    guard consecutiveRefreshes < Self.maxConsecutiveRefreshes else {
      state = .failed(.malformedResponse)
      return false
    }
    consecutiveRefreshes += 1
    await refetch()
    return state == .ready
  }

  public func playbackSucceeded() {
    consecutiveRefreshes = 0
  }

  /// The user asked to try again after a failure: a fresh budget and a fresh URL.
  public func retry() async {
    consecutiveRefreshes = 0
    await refetch()
  }

  private func refetch() async {
    state = .refreshing
    do {
      item = try await api.media(id: item.id)
      state = item.url == nil ? .failed(.notFound) : .ready
    } catch {
      state = .failed((error as? APIError) ?? .malformedResponse)
    }
  }
}
