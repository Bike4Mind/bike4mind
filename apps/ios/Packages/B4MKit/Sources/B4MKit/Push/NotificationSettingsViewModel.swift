import Foundation
import Observation

/// Drives Settings > Notifications: the master switch mirrors system authorization, the category
/// switches mirror `NotificationPrefsService`.
@MainActor
@Observable
public final class NotificationSettingsViewModel {
  public private(set) var authorization: NotificationAuthorization = .notDetermined
  public private(set) var preferences: [NotificationCategory: Bool] = [:]
  public private(set) var saveError: String?

  @ObservationIgnored private let push: PushRegistrationCoordinator
  @ObservationIgnored private let prefs: any NotificationPrefsService
  @ObservationIgnored private let settings: any SystemSettingsOpening

  public init(
    push: PushRegistrationCoordinator, prefs: any NotificationPrefsService, settings: any SystemSettingsOpening
  ) {
    self.push = push
    self.prefs = prefs
    self.settings = settings
  }

  /// The master switch is on whenever the system lets notifications through (provisional counts:
  /// they arrive quietly).
  public var isMasterEnabled: Bool { authorization.allowsDelivery }
  public var isDenied: Bool { authorization == .denied }
  /// Quiet delivery only: the switch is on but banners and sounds still need the user's yes.
  public var isDeliveringQuietly: Bool { authorization == .provisional }

  public func load() async {
    await push.refreshAuthorization()
    authorization = push.authorization
    preferences = await prefs.load()
  }

  /// iOS never lets an app switch notifications off, and a denied prompt cannot be shown again, so
  /// everything except the first-time "on" goes through the system Settings page.
  public func setMasterEnabled(_ isOn: Bool) async {
    if isOn, authorization == .notDetermined || authorization == .provisional {
      authorization = await push.requestFullAuthorization()
      return
    }
    settings.openAppSettings()
  }

  public func isEnabled(_ category: NotificationCategory) -> Bool {
    preferences[category] ?? true
  }

  public func setEnabled(_ isEnabled: Bool, for category: NotificationCategory) async {
    let previous = preferences[category]
    preferences[category] = isEnabled
    saveError = nil
    do {
      try await prefs.setEnabled(isEnabled, for: category)
    } catch {
      preferences[category] = previous
      saveError = "Couldn't save that change. Try again."
    }
  }
}
