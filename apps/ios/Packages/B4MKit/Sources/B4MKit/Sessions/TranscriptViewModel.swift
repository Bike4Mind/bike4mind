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

  public init(sessionID: String, api: any B4MAPI, pageSize: Int = 50) {
    self.sessionID = sessionID
    self.api = api
    self.pageSize = pageSize
  }

  public var hasMore: Bool { pages.hasMore }

  public func load() async {
    guard !pages.hasLoadedFirstPage else { return }
    await refresh()
  }

  /// Re-reads every page currently held. Pages run oldest-first, so re-reading only the first page
  /// would cut a long transcript back to its opening turns (a reconnect refresh must not lose what the
  /// reader paged in). On any failure the held turns stay as they were.
  public func refresh() async {
    guard !isRefreshing else { return }
    isRefreshing = true
    defer { isRefreshing = false }

    if messages.isEmpty { state = .loading }
    do {
      var fresh = PageAccumulator<QuestTurn>()
      var fetchedPages = 0
      repeat {
        let page = try await api.listSessionQuests(sessionID: sessionID, cursor: fresh.nextCursor, limit: pageSize)
        fresh.append(page)
        fetchedPages += 1
      } while fresh.hasMore && fetchedPages < loadedPageCount
      pages = fresh
      loadedPageCount = fetchedPages
      turns = pages.items
      messages = TranscriptMapper.messages(from: turns)
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
    guard let cursor = pages.nextCursor, !isLoadingMore, !isRefreshing else { return }
    isLoadingMore = true
    defer { isLoadingMore = false }
    do {
      let page = try await api.listSessionQuests(sessionID: sessionID, cursor: cursor, limit: pageSize)
      pages.append(page)
      loadedPageCount += 1
      turns = pages.items
      messages = TranscriptMapper.messages(from: turns)
      loadMoreError = nil
    } catch {
      loadMoreError = (error as? APIError) ?? .malformedResponse
    }
  }
}
