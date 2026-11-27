import Foundation

public enum RelativeTime {
  /// "2 hours ago", "yesterday". A timestamp within 45 seconds of `now` reads "Just now" instead of
  /// the formatter's "in 0 seconds".
  public static func describe(_ date: Date, now: Date = .now, locale: Locale = .current) -> String {
    if abs(now.timeIntervalSince(date)) < 45 { return "Just now" }
    let formatter = RelativeDateTimeFormatter()
    formatter.locale = locale
    formatter.dateTimeStyle = .named
    formatter.unitsStyle = .full
    return formatter.localizedString(for: date, relativeTo: now)
  }
}
