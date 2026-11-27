import Foundation
import Observation

/// Drives the brief schedule in Settings > Notifications. Every change saves at once and rolls back if
/// the server refuses it; each save stamps the device's current time zone so travel re-syncs the schedule.
@MainActor
@Observable
public final class BriefScheduleViewModel {
  public struct Weekday: Identifiable, Equatable, Sendable {
    /// Wire value: 0 = Sunday ... 6 = Saturday.
    public let id: Int
    public let shortName: String
  }

  public private(set) var schedule: BriefSchedule
  public private(set) var isLoaded = false
  public private(set) var isSaving = false
  public private(set) var errorMessage: String?

  @ObservationIgnored private let api: any BriefScheduleAPI
  @ObservationIgnored private let currentTimeZone: @Sendable () -> TimeZone
  @ObservationIgnored private let calendar: Calendar

  public init(
    api: any BriefScheduleAPI, calendar: Calendar = .autoupdatingCurrent,
    currentTimeZone: @escaping @Sendable () -> TimeZone = { TimeZone.autoupdatingCurrent }
  ) {
    self.api = api
    self.calendar = calendar
    self.currentTimeZone = currentTimeZone
    schedule = .defaults(timeZone: currentTimeZone().identifier)
  }

  /// Sunday-to-Saturday reordered to start on the locale's first weekday.
  public var weekdays: [Weekday] {
    let symbols = calendar.veryShortStandaloneWeekdaySymbols
    let first = calendar.firstWeekday - 1
    return (0..<7).map { offset in
      let id = (first + offset) % 7
      return Weekday(id: id, shortName: symbols[id])
    }
  }

  /// The scheduled time as today's date at that wall-clock time, for a `DatePicker`.
  public var time: Date {
    let parts = schedule.hourAndMinute ?? (8, 0)
    return calendar.date(bySettingHour: parts.hour, minute: parts.minute, second: 0, of: Date()) ?? Date()
  }

  public var timeZoneName: String {
    let zone = TimeZone(identifier: schedule.timeZone)
    return zone?.localizedName(for: .generic, locale: calendar.locale ?? .current) ?? schedule.timeZone
  }

  public func isSelected(_ day: Int) -> Bool { schedule.days.contains(day) }

  public func load() async {
    do {
      schedule = try await api.schedule() ?? .defaults(timeZone: currentTimeZone().identifier)
      isLoaded = true
      errorMessage = nil
    } catch {
      errorMessage = "Couldn't load your brief schedule. Try again later."
    }
  }

  public func setEnabled(_ isOn: Bool) async {
    var next = schedule
    next.enabled = isOn
    await save(next)
  }

  public func setTime(_ date: Date) async {
    let parts = calendar.dateComponents([.hour, .minute], from: date)
    var next = schedule
    next.timeOfDay = BriefSchedule.timeOfDay(hour: parts.hour ?? 0, minute: parts.minute ?? 0)
    await save(next)
  }

  /// The server needs at least one day, so the last selected day cannot be removed.
  public func toggleDay(_ day: Int) async {
    guard !isSaving else { return }
    var next = schedule
    if next.days.contains(day) {
      guard next.days.count > 1 else {
        errorMessage = "Keep at least one day selected."
        return
      }
      next.days.removeAll { $0 == day }
    } else {
      next.days = (next.days + [day]).sorted()
    }
    await save(next)
  }

  private func save(_ next: BriefSchedule) async {
    guard !isSaving else { return }
    isSaving = true
    defer { isSaving = false }
    var next = next
    next.timeZone = currentTimeZone().identifier
    let previous = schedule
    schedule = next
    errorMessage = nil
    do {
      let saved = try await api.save(next)
      schedule = saved
    } catch {
      schedule = previous
      errorMessage = "Couldn't save your brief schedule. Try again."
    }
  }
}
