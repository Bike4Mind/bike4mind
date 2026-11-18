import B4MKit
import SwiftUI

struct NotificationSettingsView: View {
  @Environment(AppServices.self) private var services

  var body: some View {
    NotificationSettingsContent(
      push: services.push, prefs: services.notificationPrefs, settings: services.systemSettings,
      briefSchedule: services.briefSchedule)
  }
}

private struct NotificationSettingsContent: View {
  /// Off until the server stores per-category preferences: the local prefs service is not read by anything that
  /// sends pushes, so these toggles would change nothing. Flip on with the server-backed service in `AppServices`.
  private static let showsCategoryPreferences = false

  @State private var model: NotificationSettingsViewModel
  @State private var brief: BriefScheduleViewModel
  @Environment(\.scenePhase) private var scenePhase

  init(
    push: PushRegistrationCoordinator, prefs: any NotificationPrefsService, settings: any SystemSettingsOpening,
    briefSchedule: any BriefScheduleAPI
  ) {
    _model = State(initialValue: NotificationSettingsViewModel(push: push, prefs: prefs, settings: settings))
    _brief = State(initialValue: BriefScheduleViewModel(api: briefSchedule))
  }

  var body: some View {
    Form {
      Group {
        masterSection
        // The schedule is server-side, so it shows even while the device-local category toggles stay hidden.
        // An enabled schedule stays visible with pushes off: it still composes and bills, so it must stay switchable.
        if model.isMasterEnabled || brief.schedule.enabled {
          briefScheduleSection
        }
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
    .task { await brief.load() }
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

  private var briefScheduleSection: some View {
    Section {
      Toggle(
        "Scheduled Brief",
        isOn: Binding(
          get: { brief.schedule.enabled },
          set: { isOn in Task { await brief.setEnabled(isOn) } })
      )
      .disabled(!brief.isLoaded)
      .accessibilityIdentifier("settings-brief-schedule-toggle")

      if brief.schedule.enabled {
        DatePicker(
          "Time",
          selection: Binding(
            get: { brief.time },
            set: { date in Task { await brief.setTime(date) } }),
          displayedComponents: .hourAndMinute
        )
        .accessibilityIdentifier("settings-brief-schedule-time")

        HStack(spacing: Tokens.Spacing.xs) {
          ForEach(brief.weekdays) { day in
            weekdayChip(day)
          }
        }
        .accessibilityIdentifier("settings-brief-schedule-days")
      }
    } header: {
      Text("Brief")
    } footer: {
      Text(briefFooter)
    }
  }

  private func weekdayChip(_ day: BriefScheduleViewModel.Weekday) -> some View {
    let isSelected = brief.isSelected(day.id)
    let name = Calendar.autoupdatingCurrent.weekdaySymbols[day.id]
    return Button {
      Task { await brief.toggleDay(day.id) }
    } label: {
      Text(day.shortName)
        .font(Tokens.Typography.caption)
        .frame(maxWidth: .infinity, minHeight: 32)
        .background(Circle().fill(isSelected ? Color.accentColor : Color.clear))
        .overlay(Circle().stroke(Color.accentColor, lineWidth: 1))
        .foregroundStyle(isSelected ? Color.white : Color.accentColor)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(name)
    .accessibilityAddTraits(isSelected ? .isSelected : [])
    .accessibilityIdentifier("settings-brief-schedule-day-\(day.id)")
  }

  private var briefFooter: String {
    if let error = brief.errorMessage { return error }
    guard brief.schedule.enabled else {
      return "Get a summary of what happened, what was handled and what needs you, on the days you pick."
    }
    return "Times are in \(brief.timeZoneName). Saving again from another time zone moves the schedule there."
  }
}
