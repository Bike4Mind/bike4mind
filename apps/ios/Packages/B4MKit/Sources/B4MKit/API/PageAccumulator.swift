import Foundation

/// The rows loaded so far for a cursor-paginated listing, plus the cursor for the next page.
/// Appending dedups by id so a row that shifts across a page boundary between fetches shows once.
public struct PageAccumulator<Item: Identifiable & Sendable>: Sendable where Item.ID: Sendable {
  public private(set) var items: [Item] = []
  public private(set) var nextCursor: String?
  /// `false` until the first page lands, so "no rows" and "not loaded yet" stay distinguishable.
  public private(set) var hasLoadedFirstPage = false

  public init() {}

  public var hasMore: Bool { nextCursor != nil }

  /// Starts over from the first page (pull-to-refresh).
  public mutating func replace(with page: Page<Item>) {
    items = []
    nextCursor = nil
    append(page)
  }

  public mutating func append(_ page: Page<Item>) {
    var seen = Set(items.map(\.id))
    for item in page.items where seen.insert(item.id).inserted {
      items.append(item)
    }
    nextCursor = page.nextCursor
    hasLoadedFirstPage = true
  }
}
