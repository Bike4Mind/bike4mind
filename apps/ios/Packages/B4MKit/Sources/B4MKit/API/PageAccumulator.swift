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

  /// Swaps the row with this id in place; a row that is no longer loaded stays absent.
  public mutating func replaceItem(id: Item.ID, with item: Item) {
    guard let index = items.firstIndex(where: { $0.id == id }) else { return }
    items[index] = item
  }

  public mutating func removeItem(id: Item.ID) {
    items.removeAll { $0.id == id }
  }

  /// Puts a row back at `index` (clamped), unless a row with its id is already loaded.
  public mutating func insertItem(_ item: Item, at index: Int) {
    guard !items.contains(where: { $0.id == item.id }) else { return }
    items.insert(item, at: min(max(index, 0), items.count))
  }
}
