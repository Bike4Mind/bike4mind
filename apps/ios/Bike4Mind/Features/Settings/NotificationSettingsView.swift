import B4MKit
import SwiftUI

struct NotificationSettingsView: View {
  @Environment(AppServices.self) private var services

  var body: some View {
    NotificationSettingsContent(
      push: services.push, prefs: services.notificationPrefs, settings: services.systemSettings,
      briefSchedule: services.briefSchedule, busyBlocks: services.busyBlocks, calendar: services.busyBlockReader,
      busyBlockSyncer: services.busyBlockSyncer, interruptionFeedback: services.interruptionFeedback)
  }
}

private struct NotificationSettingsContent: View {
  /// Off until the server stores per-category preferences: the local prefs service is not read by anything that
  /// sends pushes, so these toggles would change nothing. Flip on with the server-backed service in `AppServices`.
  private static let showsCategoryPreferences = false

  @State private var model: NotificationSettingsViewModel
  @State private var brief: BriefScheduleViewModel
  @State private var busyBlocks: BusyBlockBriefViewModel
  @State private var interruptions: InterruptionFeedbackViewModel
  private let settings: any SystemSettingsOpening
  @Environment(\.scenePhase) private var scenePhase
  @Environment(AuthController.self) private var auth

  init(
    push: PushRegistrationCoordinator, prefs: any NotificationPrefsService, settings: any SystemSettingsOpening,
    briefSchedule: any BriefScheduleAPI, busyBlocks: any BusyBlocksAPI, calendar: any BusyBlockReader,
    busyBlockSyncer: BusyBlockSyncer, interruptionFeedback: any InterruptionFeedbackAPI
  ) {
    self.settings = settings
    _model = State(initialValue: NotificationSettingsViewModel(push: push, prefs: prefs, settings: settings))
    _brief = State(initialValue: BriefScheduleViewModel(api: briefSchedule))
    _busyBlocks = State(
      initialValue: BusyBlockBriefViewModel(api: busyBlocks, reader: calendar, syncer: busyBlockSyncer))
    _interruptions = State(initialValue: InterruptionFeedbackViewModel(api: interruptionFeedback))
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
        // Same rule as the schedule: an enabled opt-in stays switchable with pushes off.
        if model.isMasterEnabled || busyBlocks.isEnabled {
          busyBlockSection
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
    .onChange(of: auth.captureSession().id, initial: true) { _, _ in busyBlocks.scheduleLoad() }
    .task(id: scenePhase) {
      if scenePhase == .active && !interruptions.isLoaded { await interruptions.load() }
    }
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
      .disabled(!brief.isLoaded || brief.isSaving)
      .accessibilityIdentifier("settings-brief-schedule-toggle")

      if brief.schedule.enabled {
        DatePicker(
          "Time",
          selection: Binding(
            get: { brief.time },
            set: { date in Task { await brief.setTime(date) } }),
          displayedComponents: .hourAndMinute
        )
        .disabled(brief.isSaving)
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

  @ViewBuilder
  private var busyBlockSection: some View {
    Section {
      Toggle(
        "Brief After Busy Blocks",
        isOn: Binding(
          get: { busyBlocks.isEnabled },
          set: { isOn in busyBlocks.scheduleSetEnabled(isOn) })
      )
      .disabled(!busyBlocks.isLoaded || busyBlocks.isSaving)
      .accessibilityIdentifier("settings-busy-block-brief-toggle")

      if busyBlocks.isAccessDenied {
        Button("Open Settings") { settings.openAppSettings() }
          .accessibilityIdentifier("settings-busy-block-open-settings")
      }
    } footer: {
      Text(busyBlockFooter)
    }
    if busyBlocks.isEnabled {
      afterBusyBlockSection
    }
  }

  private var afterBusyBlockSection: some View {
    Section {
      quietToggle(.agentCompleted, "Don't notify me about finished agent runs after a busy block")
      quietToggle(.agentFailed, "Don't notify me about failed agent runs after a busy block")
    } footer: {
      Text(
        interruptions.errorMessage
          ?? "The brief still arrives in the Briefs tab. If no brief is composed for the block, you still get a short "
          + "summary of the runs. A brief with a decision waiting on you still notifies.")
    }
  }

  private func quietToggle(_ category: InterruptionCategory, _ title: String) -> some View {
    Toggle(
      title,
      isOn: Binding(
        get: { interruptions.isQuiet(category) },
        set: { isOn in Task { await interruptions.setQuiet(category, isOn) } })
    )
    .disabled(!interruptions.isLoaded || interruptions.isSaving)
    .accessibilityIdentifier("settings-interruption-\(category.rawValue)-toggle")
  }

  private var busyBlockFooter: String {
    if let error = busyBlocks.errorMessage { return error }
    if busyBlocks.isAccessDenied {
      return "Bike4Mind needs calendar access for this. Allow Full Access in iOS Settings, then turn it on again."
    }
    return
      "Hold run updates while a calendar event marks you busy, then get one brief of what happened when it ends. "
      + "Only event start and end times leave this device."
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
        .background(Circle().fill(isSelected ? Tokens.Palette.brand : Color.clear))
        .overlay(Circle().stroke(Tokens.Palette.brand, lineWidth: 1))
        .foregroundStyle(isSelected ? Color.white : Tokens.Palette.brand)
    }
    .buttonStyle(.plain)
    .disabled(brief.isSaving)
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
