import Foundation

/// When the server composes a brief for the user. Mirrors `BriefScheduleSchema` in
/// `b4m-core/common/src/schemas/brief.ts`; the server reads `timeOfDay` and `days` in `timeZone`.
public struct BriefSchedule: Codable, Equatable, Sendable {
  public var enabled: Bool
  /// 24-hour `HH:mm`.
  public var timeOfDay: String
  /// 0 = Sunday ... 6 = Saturday, which is `Calendar` weekday minus one.
  public var days: [Int]
  /// IANA identifier, e.g. `America/New_York`.
  public var timeZone: String

  public init(enabled: Bool, timeOfDay: String, days: [Int], timeZone: String) {
    self.enabled = enabled
    self.timeOfDay = timeOfDay
    self.days = days
    self.timeZone = timeZone
  }

  /// What a user who never saved a schedule sees: off, 08:00 on weekdays.
  public static func defaults(timeZone: String) -> BriefSchedule {
    BriefSchedule(enabled: false, timeOfDay: "08:00", days: [1, 2, 3, 4, 5], timeZone: timeZone)
  }

  /// `timeOfDay` as hour and minute, or nil when the string is not `HH:mm`.
  public var hourAndMinute: (hour: Int, minute: Int)? {
    let parts = timeOfDay.split(separator: ":")
    guard parts.count == 2, let hour = Int(parts[0]), let minute = Int(parts[1]),
      (0..<24).contains(hour), (0..<60).contains(minute)
    else { return nil }
    return (hour, minute)
  }

  public static func timeOfDay(hour: Int, minute: Int) -> String {
    String(format: "%02d:%02d", hour, minute)
  }
}
