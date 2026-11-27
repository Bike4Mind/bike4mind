import B4MKit
import EventKit

/// Reads busy times from every calendar on the device. Only start, end, all-day and availability are read;
/// `BusyBlockFilter` decides what counts as busy.
final class EventKitBusyBlockReader: BusyBlockReader, @unchecked Sendable {
  let store = EKEventStore()

  func access() -> BusyBlockAccess {
    switch EKEventStore.authorizationStatus(for: .event) {
    case .fullAccess: return .authorized
    case .notDetermined: return .notDetermined
    default: return .denied
    }
  }

  func requestAccess() async -> Bool {
    switch EKEventStore.authorizationStatus(for: .event) {
    case .fullAccess:
      return true
    case .notDetermined:
      return (try? await store.requestFullAccessToEvents()) ?? false
    default:
      return false
    }
  }

  func events(from start: Date, to end: Date) -> [CalendarEventSample] {
    let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
    return store.events(matching: predicate).map { event in
      CalendarEventSample(
        start: event.startDate, end: event.endDate, isAllDay: event.isAllDay,
        availability: Self.availability(event.availability))
    }
  }

  private static func availability(_ value: EKEventAvailability) -> CalendarEventSample.Availability {
    switch value {
    case .busy: return .busy
    case .tentative: return .tentative
    case .unavailable: return .unavailable
    case .free: return .free
    case .notSupported: return .notSupported
    @unknown default: return .busy
    }
  }
}
