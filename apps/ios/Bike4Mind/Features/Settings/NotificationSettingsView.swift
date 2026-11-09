import B4MKit
import SwiftUI

struct NotificationSettingsView: View {
  @Environment(AppServices.self) private var services

  var body: some View {
    NotificationSettingsContent(
      push: services.push, prefs: services.notificationPrefs, settings: services.systemSettings)
  }
}

private struct NotificationSettingsContent: View {
  /// Off until the server stores per-category preferences: the local prefs service is not read by anything that
  /// sends pushes, so these toggles would change nothing. Flip on with the server-backed service in `AppServices`.
  private static let showsCategoryPreferences = false

  @State private var model: NotificationSettingsViewModel
  @Environment(\.scenePhase) private var scenePhase

  init(push: PushRegistrationCoordinator, prefs: any NotificationPrefsService, settings: any SystemSettingsOpening) {
    _model = State(initialValue: NotificationSettingsViewModel(push: push, prefs: prefs, settings: settings))
  }

  var body: some View {
    Form {
      Group {
        masterSection
        if Self.showsCategoryPreferences, model.isMasterEnabled {
          categorySection
        }
      }
      .listRowBackground(Tokens.Palette.groupedBackground)
    }
    .brandedListChrome()
    .navigationTitle("Notifications")
    .navigationBarTitleDisplayMode(.inline)
    // Reloads on return from iOS Settings, where the user may have changed the system switch.
    .task(id: scenePhase) { if scenePhase == .active { await model.load() } }
  }

  private var masterSection: some View {
    Section {
      Toggle(
        "Allow Notifications",
        isOn: Binding(
          get: { model.isMasterEnabled },
          set: { isOn in Task { await model.setMasterEnabled(isOn) } })
      )
      .accessibilityIdentifier("notifications-master-toggle")
    } footer: {
      Text(masterFooter)
    }
  }

  private var masterFooter: String {
    if model.isDenied {
      return "Notifications are off for Bike4Mind in iOS Settings. Turn this on to open Settings and allow them."
    }
    if model.isDeliveringQuietly {
      return "Updates arrive quietly in Notification Center. Turn this on again to allow banners and sounds."
    }
    return "Hear from Bike4Mind the moment something you started is ready. Change this any time in iOS Settings."
  }

  private var categorySection: some View {
    Section {
      ForEach(NotificationCategory.allCases) { category in
        Toggle(
          isOn: Binding(
            get: { model.isEnabled(category) },
            set: { isOn in Task { await model.setEnabled(isOn, for: category) } })
        ) {
          VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
            Text(category.title)
            Text(category.detail)
              .font(Tokens.Typography.caption)
              .foregroundStyle(Tokens.Palette.secondaryText)
          }
        }
        .accessibilityIdentifier("notifications-\(category.rawValue)-toggle")
      }
    } header: {
      Text("Tell me when")
    } footer: {
      if let error = model.saveError { Text(error) }
    }
  }
}
