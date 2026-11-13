import Foundation

/// Per-category push preferences.
///
/// GAP: the server surface for `userSettings.pushNotifications` (read/write endpoints) was still
/// being built when this was written, so `LocalNotificationPrefsService` stores prefs on the device
/// only and the server keeps its defaults. TODO: add a `RemoteNotificationPrefsService` that reads
/// and writes the server value (local copy as an offline cache) and swap it in at `AppServices`.
public protocol NotificationPrefsService: Sendable {
  /// Every category, defaulting to enabled when never set.
  func load() async -> [NotificationCategory: Bool]
  func setEnabled(_ isEnabled: Bool, for category: NotificationCategory) async throws
}

public struct LocalNotificationPrefsService: NotificationPrefsService {
  private let suiteName: String?

  /// - Parameter suiteName: a `UserDefaults` suite; `nil` means `.standard`.
  public init(suiteName: String? = nil) {
    self.suiteName = suiteName
  }

  private var defaults: UserDefaults {
    suiteName.flatMap(UserDefaults.init(suiteName:)) ?? .standard
  }

  private static func key(_ category: NotificationCategory) -> String {
    "b4m.push.pref.\(category.rawValue)"
  }

  public func load() async -> [NotificationCategory: Bool] {
    let defaults = self.defaults
    return Dictionary(
      uniqueKeysWithValues: NotificationCategory.allCases.map { category in
        let stored = defaults.object(forKey: Self.key(category)) as? Bool
        return (category, stored ?? true)
      })
  }

  public func setEnabled(_ isEnabled: Bool, for category: NotificationCategory) async throws {
    defaults.set(isEnabled, forKey: Self.key(category))
  }
}
