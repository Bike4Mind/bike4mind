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
  /// The refresh in flight. Unstructured so one view going away (the drawer closing) cannot cancel a refresh
  /// another view is waiting on.
  @ObservationIgnored private var refreshTask: Task<Void, Never>?
  private var mutatingIDs: Set<String> = []
  @ObservationIgnored private let onDeleted: @MainActor (String) async -> Void
  @ObservationIgnored private let onRenamed: @MainActor (String, String) async -> Void
  /// Bumped by `reset()`. Work that awaited across a reset belongs to the previous account and must not write.
  @ObservationIgnored private var generation = 0

  /// `onDeleted` runs once the server confirms a delete, to drop what other stores keep for that session;
  /// `onRenamed` runs with the id and the server's name once it confirms a rename.
  public init(
    api: any B4MAPI, cache: any SessionListCache, pageSize: Int = 25,
    onDeleted: @escaping @MainActor (String) async -> Void = { _ in },
    onRenamed: @escaping @MainActor (String, String) async -> Void = { _, _ in }
  ) {
    self.api = api
    self.cache = cache
    self.pageSize = pageSize
    self.onDeleted = onDeleted
    self.onRenamed = onRenamed
  }

  public var hasMore: Bool { pages.hasMore }

  /// The newest sessions for the drawer's shortcut list, in list order.
  public var drawerRecents: ArraySlice<SessionSummary> { sessions.prefix(Self.drawerRecentCount) }
  static let drawerRecentCount = 5

  /// First appearance: paint cached rows immediately, then refresh.
  public func load() async {
    let generation = self.generation
    if sessions.isEmpty, let cached = await cache.load(), !cached.isEmpty {
      guard generation == self.generation else { return }
      sessions = cached
      isShowingCachedRows = true
    }
    await refresh()
  }

  public func refresh() async {
    if let refreshTask { return await refreshTask.value }
    let task = Task { await self.performRefresh() }
    refreshTask = task
    await task.value
  }

  // A refresh requested before a rename commits can bring back the old name (and cache it) until the next
  // refresh. Accepted: the server copy is what the list shows, and the window is one round trip.
  private func performRefresh() async {
    let generation = self.generation
    defer { if generation == self.generation { refreshTask = nil } }

    if sessions.isEmpty { state = .loading }
    do {
      let page = try await api.listSessions(cursor: nil, limit: pageSize)
      guard generation == self.generation else { return }
      pages.replace(with: page)
      sessions = pages.items
      isShowingCachedRows = false
      loadMoreError = nil
      state = .loaded
      await cache.save(pages.items)
    } catch {
      guard generation == self.generation else { return }
      if Self.isCancellation(error) {
        if state == .loading { state = .idle }
        return
      }
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
    guard let cursor = pages.nextCursor, !isLoadingMore, refreshTask == nil, !isShowingCachedRows else { return }
    let generation = self.generation
    isLoadingMore = true
    defer { if generation == self.generation { isLoadingMore = false } }
    do {
      let page = try await api.listSessions(cursor: cursor, limit: pageSize)
      guard generation == self.generation else { return }
      pages.append(page)
      sessions = pages.items
      loadMoreError = nil
    } catch {
      guard generation == self.generation, !Self.isCancellation(error) else { return }
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
    let generation = self.generation
    mutatingIDs.insert(id)
    defer { if generation == self.generation { mutatingIDs.remove(id) } }
    mutationError = nil

    let optimistic = SessionSummary(
      id: id, name: name, lastUsedModel: original.lastUsedModel, firstCreated: original.firstCreated,
      lastUpdated: original.lastUpdated)
    replace(id, with: optimistic)
    do {
      let saved = try await api.renameSession(id: id, name: name)
      guard generation == self.generation else { return }
      replace(id, with: saved)
      await onRenamed(id, saved.name)
    } catch {
      guard generation == self.generation else { return }
      let apiError = Self.apiError(from: error)
      if apiError == .notFound {
        remove(id)
      } else if sessions.first(where: { $0.id == id })?.name == name {
        // A refresh that landed meanwhile owns the row unless it still shows our optimistic name.
        replace(id, with: original)
      }
      mutationError = apiError
    }
    guard generation == self.generation else { return }
    await cache.save(sessions)
  }

  /// Removes the row at once, then puts it back where it was if the server refuses. A session the server no
  /// longer has counts as deleted.
  public func delete(_ id: String) async {
    guard !mutatingIDs.contains(id), let index = sessions.firstIndex(where: { $0.id == id }) else { return }
    let generation = self.generation
    mutatingIDs.insert(id)
    defer { if generation == self.generation { mutatingIDs.remove(id) } }
    mutationError = nil

    let original = sessions[index]
    let pageIndex = pages.items.firstIndex(where: { $0.id == id })
    remove(id)
    do {
      do {
        try await api.deleteSession(id: id)
      } catch APIError.notFound {}
      guard generation == self.generation else { return }
      // A refresh or next page fetched before the server committed may have brought the row back.
      remove(id)
      await onDeleted(id)
    } catch {
      guard generation == self.generation else { return }
      if !sessions.contains(where: { $0.id == id }) {
        if let pageIndex { pages.insertItem(original, at: pageIndex) }
        sessions.insert(original, at: min(index, sessions.count))
      }
      mutationError = Self.apiError(from: error)
    }
    guard generation == self.generation else { return }
    await cache.save(sessions)
  }

  /// `true` while a rename or delete of `id` is in flight; a second one would be ignored, so the UI disables both.
  public func isMutating(_ id: String) -> Bool { mutatingIDs.contains(id) }

  public func dismissMutationError() { mutationError = nil }

  /// Sign-out: rows belong to the account that fetched them.
  public func reset() {
    generation += 1
    pages = PageAccumulator()
    sessions = []
    state = .idle
    isLoadingMore = false
    refreshTask = nil
    mutatingIDs = []
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

  // A cancelled URLSession request surfaces as `APIError.offline` (AuthorizedRequester maps every URLError),
  // so the task's own cancellation flag is the reliable signal that a view went away, not a real failure.
  private static func isCancellation(_ error: any Error) -> Bool {
    Task.isCancelled || error is CancellationError
  }
}
