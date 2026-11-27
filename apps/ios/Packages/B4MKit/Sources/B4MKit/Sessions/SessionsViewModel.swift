import Foundation
import Observation

/// Drives the sessions list: cache-first render, refresh from the server, cursor pagination, and optimistic
/// rename and delete. One instance backs both the drawer and the Notebooks screen (`AppServices.sessionsModel`).
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
  /// The last rename or delete that failed and was rolled back; `nil` once dismissed or after the next mutation.
  public private(set) var mutationError: APIError?

  @ObservationIgnored private var pages = PageAccumulator<SessionSummary>()
  @ObservationIgnored private let api: any B4MAPI
  @ObservationIgnored private let cache: any SessionListCache
  @ObservationIgnored private let pageSize: Int
  @ObservationIgnored private var isRefreshing = false
  @ObservationIgnored private var mutatingIDs: Set<String> = []
  @ObservationIgnored private let onDeleted: @MainActor (String) async -> Void

  /// `onDeleted` runs once the server confirms a delete, to drop what other stores keep for that session.
  public init(
    api: any B4MAPI, cache: any SessionListCache, pageSize: Int = 25,
    onDeleted: @escaping @MainActor (String) async -> Void = { _ in }
  ) {
    self.api = api
    self.cache = cache
    self.pageSize = pageSize
    self.onDeleted = onDeleted
  }

  public var hasMore: Bool { pages.hasMore }

  /// The newest sessions for the drawer's shortcut list, in list order.
  public var drawerRecents: ArraySlice<SessionSummary> { sessions.prefix(Self.drawerRecentCount) }
  static let drawerRecentCount = 5

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

  /// Shows `name` at once, then keeps the server's copy, or puts the old name back if the call fails. Blank or
  /// unchanged names, and a second mutation of a row that already has one in flight, are ignored.
  public func rename(_ id: String, to name: String) async {
    let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty, !mutatingIDs.contains(id),
      let original = sessions.first(where: { $0.id == id }), original.name != name
    else { return }
    mutatingIDs.insert(id)
    defer { mutatingIDs.remove(id) }
    mutationError = nil

    let optimistic = SessionSummary(
      id: id, name: name, lastUsedModel: original.lastUsedModel, firstCreated: original.firstCreated,
      lastUpdated: original.lastUpdated)
    replace(id, with: optimistic)
    do {
      let saved = try await api.renameSession(id: id, name: name)
      replace(id, with: saved)
    } catch {
      let apiError = Self.apiError(from: error)
      if apiError == .notFound {
        remove(id)
      } else if sessions.first(where: { $0.id == id })?.name == name {
        // A refresh that landed meanwhile owns the row unless it still shows our optimistic name.
        replace(id, with: original)
      }
      mutationError = apiError
    }
    await cache.save(sessions)
  }

  /// Removes the row at once, then puts it back where it was if the server refuses. A session the server no
  /// longer has counts as deleted.
  public func delete(_ id: String) async {
    guard !mutatingIDs.contains(id), let index = sessions.firstIndex(where: { $0.id == id }) else { return }
    mutatingIDs.insert(id)
    defer { mutatingIDs.remove(id) }
    mutationError = nil

    let original = sessions[index]
    let pageIndex = pages.items.firstIndex(where: { $0.id == id })
    remove(id)
    do {
      do {
        try await api.deleteSession(id: id)
      } catch APIError.notFound {}
      // A refresh or next page fetched before the server committed may have brought the row back.
      remove(id)
      await onDeleted(id)
    } catch {
      if !sessions.contains(where: { $0.id == id }) {
        if let pageIndex { pages.insertItem(original, at: pageIndex) }
        sessions.insert(original, at: min(index, sessions.count))
      }
      mutationError = Self.apiError(from: error)
    }
    await cache.save(sessions)
  }

  public func dismissMutationError() { mutationError = nil }

  /// Sign-out: rows belong to the account that fetched them.
  public func reset() {
    pages = PageAccumulator()
    sessions = []
    state = .idle
    isLoadingMore = false
    loadMoreError = nil
    isShowingCachedRows = false
    mutationError = nil
  }

  // `sessions` mirrors `pages.items` except while cached rows are shown, so both are edited: a later
  // `loadMore` rebuilds `sessions` from `pages` and would otherwise bring back the old row.
  private func replace(_ id: String, with session: SessionSummary) {
    pages.replaceItem(id: id, with: session)
    if let index = sessions.firstIndex(where: { $0.id == id }) { sessions[index] = session }
  }

  private func remove(_ id: String) {
    pages.removeItem(id: id)
    sessions.removeAll { $0.id == id }
  }

  private static func apiError(from error: any Error) -> APIError {
    (error as? APIError) ?? .malformedResponse
  }
}
