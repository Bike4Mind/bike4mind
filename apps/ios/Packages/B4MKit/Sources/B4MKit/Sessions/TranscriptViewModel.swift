import Foundation
import Observation

/// Read-only history of one session. The API pages oldest-first, so the end of a long conversation
/// is reached by loading forward; the view asks for the next page as the reader nears the bottom.
@MainActor
@Observable
public final class TranscriptViewModel {
  public let sessionID: String
  public private(set) var messages: [TranscriptMessage] = []
  /// The loaded turns behind `messages`, oldest first. Chat overlays live turns on these.
  public private(set) var turns: [QuestTurn] = []
  public private(set) var state: ListLoadState = .idle
  public private(set) var isLoadingMore = false
  public private(set) var loadMoreError: APIError?

  @ObservationIgnored private var pages = PageAccumulator<QuestTurn>()
  @ObservationIgnored private let api: any B4MAPI
  @ObservationIgnored private let pageSize: Int
  @ObservationIgnored private var isRefreshing = false
  @ObservationIgnored private var loadedPageCount = 0
  @ObservationIgnored private let cache: SettledTranscriptCache?
  @ObservationIgnored private let cacheGeneration: UUID?
  @ObservationIgnored private var cacheToken: SettledTranscriptCache.Token?
  @ObservationIgnored private var loadedPages: [Page<QuestTurn>] = []
  @ObservationIgnored private var revalidateLastPage = false
  @ObservationIgnored private var canCache = true

  public init(sessionID: String, api: any B4MAPI, pageSize: Int = 50, cache: SettledTranscriptCache? = nil) {
    self.sessionID = sessionID
    self.api = api
    self.pageSize = pageSize
    self.cache = cache
    cacheGeneration = cache?.generation
  }

  private func beginCacheRequest() -> SettledTranscriptCache.Admission? {
    guard canCache, let cacheGeneration else { return nil }
    let admission = cache?.begin(sessionID: sessionID, pageSize: pageSize, generation: cacheGeneration)
    cacheToken = admission?.token
    return admission
  }

  private func seedCacheIfNeeded() {
    guard !pages.hasLoadedFirstPage, !isRefreshing, !isLoadingMore, canCache, cacheGeneration == cache?.generation
    else { return }
    if let snapshot = beginCacheRequest()?.snapshot {
      loadedPages = snapshot.pages
      loadedPageCount = loadedPages.count
      revalidateLastPage = snapshot.revalidateLastPage
      for page in loadedPages { pages.append(page) }
      turns = pages.items
      messages = TranscriptMapper.messages(from: turns)
      state = .loaded
    }
  }

  public var hasMore: Bool { pages.hasMore }

  public func load() async {
    seedCacheIfNeeded()
    if revalidateLastPage {
      await reloadCachedTail()
      return
    }
    guard !pages.hasLoadedFirstPage else { return }
    await refresh()
  }

  func invalidateCache() {
    canCache = false
    if let cacheGeneration { cache?.remove(sessionID: sessionID, generation: cacheGeneration) }
  }

  private func reloadCachedTail() async {
    guard !isRefreshing else { return }
    isRefreshing = true
    defer { isRefreshing = false }
    let requestToken = cacheToken
    do {
      let cursor = loadedPages.dropLast().last?.nextCursor
      let page = try await api.listSessionQuests(sessionID: sessionID, cursor: cursor, limit: pageSize)
      loadedPages[loadedPages.count - 1] = page
      pages = PageAccumulator()
      for page in loadedPages { pages.append(page) }
      revalidateLastPage = false
      publish(cacheToken: requestToken)
      state = .loaded
    } catch {
      state = .failed((error as? APIError) ?? .malformedResponse)
    }
  }

  private func publish(cacheToken: SettledTranscriptCache.Token?) {
    turns = pages.items
    messages = TranscriptMapper.messages(from: turns)
    if canCache, let cacheGeneration, let cacheToken {
      cache?.save(
        sessionID: sessionID, pageSize: pageSize, pages: loadedPages, generation: cacheGeneration, token: cacheToken)
    }
  }

  /// Re-reads every page currently held. Pages run oldest-first, so re-reading only the first page
  /// would cut a long transcript back to its opening turns (a reconnect refresh must not lose what the
  /// reader paged in). On any failure the held turns stay as they were.
  public func refresh() async {
    guard !isRefreshing else { return }
    isRefreshing = true
    defer { isRefreshing = false }
    let requestToken = beginCacheRequest()?.token

    if messages.isEmpty { state = .loading }
    do {
      var fresh = PageAccumulator<QuestTurn>()
      var freshPages: [Page<QuestTurn>] = []
      var fetchedPages = 0
      repeat {
        let page = try await api.listSessionQuests(sessionID: sessionID, cursor: fresh.nextCursor, limit: pageSize)
        fresh.append(page)
        freshPages.append(page)
        fetchedPages += 1
      } while fresh.hasMore && fetchedPages < loadedPageCount
      pages = fresh
      loadedPageCount = fetchedPages
      loadedPages = freshPages
      revalidateLastPage = false
      publish(cacheToken: requestToken)
      loadMoreError = nil
      state = .loaded
    } catch {
      state = .failed((error as? APIError) ?? .malformedResponse)
    }
  }

  public func loadMoreIfNeeded(currentMessage: TranscriptMessage) async {
    guard let index = messages.firstIndex(where: { $0.id == currentMessage.id }),
      index >= messages.count - 3
    else { return }
    await loadMore()
  }

  public func loadMore() async {
    seedCacheIfNeeded()
    if revalidateLastPage {
      await reloadCachedTail()
      return
    }
    guard let cursor = pages.nextCursor, !isLoadingMore, !isRefreshing else { return }
    isLoadingMore = true
    defer { isLoadingMore = false }
    let requestToken = cacheToken
    do {
      let page = try await api.listSessionQuests(sessionID: sessionID, cursor: cursor, limit: pageSize)
      pages.append(page)
      loadedPages.append(page)
      loadedPageCount += 1
      publish(cacheToken: requestToken)
      loadMoreError = nil
    } catch {
      loadMoreError = (error as? APIError) ?? .malformedResponse
    }
  }
}
