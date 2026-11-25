import Foundation

/// A busy interval from the device calendar. Mirrors `BusyBlockSchema` in `b4m-core/common/src/schemas/brief.ts`:
/// only the times leave the device, never a title, attendee or calendar.
public struct BusyBlock: Codable, Equatable, Sendable {
  public var start: Date
  public var end: Date

  public init(start: Date, end: Date) {
    self.start = start
    self.end = end
  }
}

/// The server's view of busy-block briefs: the opt-in and the blocks it kept after merging overlaps.
public struct BusyBlocksState: Codable, Equatable, Sendable {
  public var enabled: Bool
  public var blocks: [BusyBlock]
  public var nextBlockBriefAt: Date?

  public init(enabled: Bool, blocks: [BusyBlock], nextBlockBriefAt: Date? = nil) {
    self.enabled = enabled
    self.blocks = blocks
    self.nextBlockBriefAt = nextBlockBriefAt
  }
}

/// A calendar event as the reader sees it, before filtering down to busy blocks.
public struct CalendarEventSample: Equatable, Sendable {
  public enum Availability: Sendable {
    case busy, tentative, unavailable, free, notSupported
  }

  public var start: Date
  public var end: Date
  public var isAllDay: Bool
  public var availability: Availability

  public init(start: Date, end: Date, isAllDay: Bool, availability: Availability) {
    self.start = start
    self.end = end
    self.isAllDay = isAllDay
    self.availability = availability
  }
}

public enum BusyBlockFilter {
  /// Server limits from `BUSY_BLOCK_LIMITS` in `b4m-core/common/src/schemas/brief.ts`; keep in sync.
  public static let maxBlocks = 48
  public static let maxDuration: TimeInterval = 12 * 60 * 60

  /// How far back and ahead the device calendar is read on each sync.
  public static let lookBehind: TimeInterval = 60 * 60
  public static let lookAhead: TimeInterval = 48 * 60 * 60

  /// All-day and free events are not busy time. A block longer than the server allows is dropped rather than
  /// clipped, since a clipped end would trigger a brief while the user is still busy.
  public static func blocks(from events: [CalendarEventSample]) -> [BusyBlock] {
    let kept =
      events
      .filter { !$0.isAllDay && $0.availability != .free }
      .filter { $0.end > $0.start && $0.end.timeIntervalSince($0.start) <= maxDuration }
      .map { BusyBlock(start: $0.start, end: $0.end) }
      .sorted { ($0.end, $0.start) < ($1.end, $1.start) }
    return Array(kept.prefix(maxBlocks))
  }
}

/// ISO 8601 with milliseconds, the shape the server's `toISOString()` returns; parsing also takes whole seconds.
enum BusyBlockDates {
  private static func formatter(fractional: Bool) -> ISO8601DateFormatter {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = fractional ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
    return formatter
  }

  static func string(from date: Date) -> String {
    formatter(fractional: true).string(from: date)
  }

  static func date(from string: String) -> Date? {
    formatter(fractional: true).date(from: string) ?? formatter(fractional: false).date(from: string)
  }
}
