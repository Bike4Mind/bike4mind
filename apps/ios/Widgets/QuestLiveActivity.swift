import ActivityKit
import B4MKit
import SwiftUI
import WidgetKit

/// The Live Activity for a quest (a chat turn or an agent run): lock screen banner and Dynamic Island.
/// The app starts and updates it (`QuestActivityManager`); the server's pushes update it while the app is
/// closed. A tap opens the session; approvals are read-only in the app for now, so an approval tap opens the
/// same place.
struct QuestLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: QuestActivityAttributes.self) { context in
      QuestLockScreenView(
        attributes: context.attributes, state: context.state, isStale: context.isStale
      )
      .activityBackgroundTint(QuestActivityStyle.background(for: QuestActivityPresentation(context.state)))
      .activitySystemActionForegroundColor(.primary)
      .widgetURL(WidgetDestination.notebook(context.attributes.sessionId))
    } dynamicIsland: { context in
      let presentation = QuestActivityPresentation(context.state)
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          QuestStatusGlyph(presentation: presentation, size: 28)
            .padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Text(presentation.statusText)
            .font(.caption.weight(.semibold))
            .foregroundStyle(WidgetStyle.color(for: presentation.tone))
            .padding(.trailing, 4)
        }
        DynamicIslandExpandedRegion(.center) {
          Text(context.attributes.title)
            .font(.subheadline.weight(.semibold))
            .lineLimit(1)
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 6) {
            Text(presentation.detail)
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(2)
            if let progress = presentation.progress {
              ProgressView(value: progress).tint(WidgetStyle.color(for: presentation.tone))
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
      } compactLeading: {
        QuestCompactLeading(presentation: presentation)
      } compactTrailing: {
        QuestCompactTrailing(presentation: presentation, startedAt: context.attributes.startedAt)
      } minimal: {
        QuestCompactLeading(presentation: presentation)
      }
      .widgetURL(WidgetDestination.notebook(context.attributes.sessionId))
      .keylineTint(WidgetStyle.color(for: presentation.tone))
    }
  }
}

enum QuestActivityStyle {
  /// Only the states that need the user stand out; a running quest keeps the system's lock screen material.
  static func background(for presentation: QuestActivityPresentation) -> Color? {
    switch presentation.tone {
    case .attention: BrandTheme.warning.opacity(0.28)
    case .failure: BrandTheme.destructive.opacity(0.16)
    case .active, .success, .neutral: nil
    }
  }
}

/// The status as one symbol; a ring around it when the run reports progress.
struct QuestStatusGlyph: View {
  let presentation: QuestActivityPresentation
  let size: CGFloat

  var body: some View {
    ZStack {
      if let progress = presentation.progress {
        Circle().stroke(.tertiary, lineWidth: 3)
        Circle()
          .trim(from: 0, to: progress)
          .stroke(WidgetStyle.color(for: presentation.tone), style: StrokeStyle(lineWidth: 3, lineCap: .round))
          .rotationEffect(.degrees(-90))
      }
      Image(systemName: presentation.symbolName)
        .font(.system(size: size * (presentation.progress == nil ? 0.8 : 0.45), weight: .semibold))
        .foregroundStyle(WidgetStyle.color(for: presentation.tone))
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}

private struct QuestCompactLeading: View {
  let presentation: QuestActivityPresentation

  var body: some View {
    QuestStatusGlyph(presentation: presentation, size: 20)
  }
}

private struct QuestCompactTrailing: View {
  let presentation: QuestActivityPresentation
  let startedAt: Date

  var body: some View {
    if presentation.isTerminal || presentation.isUrgent {
      Image(systemName: presentation.isUrgent ? "exclamationmark" : presentation.symbolName)
        .font(.caption.weight(.bold))
        .foregroundStyle(WidgetStyle.color(for: presentation.tone))
    } else {
      // A timer-driven ring is the one indeterminate indicator the system keeps animating off-process.
      ProgressView(
        timerInterval: startedAt...startedAt.addingTimeInterval(3_600), countsDown: false,
        label: { EmptyView() }, currentValueLabel: { EmptyView() }
      )
      .progressViewStyle(.circular)
      .tint(WidgetStyle.color(for: presentation.tone))
    }
  }
}

struct QuestLockScreenView: View {
  let attributes: QuestActivityAttributes
  let state: QuestActivityContentState
  var isStale = false

  private var presentation: QuestActivityPresentation { QuestActivityPresentation(state) }

  var body: some View {
    let tint = WidgetStyle.color(for: presentation.tone)
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 12) {
        QuestStatusGlyph(presentation: presentation, size: 36)
        VStack(alignment: .leading, spacing: 2) {
          Text(attributes.title)
            .font(.headline)
            .lineLimit(1)
          Text(isStale && !presentation.isTerminal ? "Waiting for an update" : presentation.detail)
            .font(.subheadline)
            .foregroundStyle(presentation.isUrgent ? .primary : .secondary)
            .lineLimit(2)
        }
        Spacer(minLength: 8)
        VStack(alignment: .trailing, spacing: 2) {
          Text(presentation.statusText)
            .font(.caption.weight(.semibold))
            .foregroundStyle(tint)
          if !presentation.isTerminal {
            Text(attributes.startedAt, style: .timer)
              .font(.caption.monospacedDigit())
              .foregroundStyle(.secondary)
              .multilineTextAlignment(.trailing)
              .frame(maxWidth: 56, alignment: .trailing)
          }
        }
      }
      if let progress = presentation.progress {
        ProgressView(value: progress).tint(tint)
      }
      if presentation.isUrgent {
        Label("Tap to review in Bike4Mind", systemImage: "arrow.up.forward.app")
          .font(.caption.weight(.semibold))
          .foregroundStyle(tint)
      }
    }
    .padding(16)
    .opacity(isStale && !presentation.isTerminal ? 0.7 : 1)
  }
}

#if DEBUG
  #Preview("Lock screen", as: .content, using: QuestActivityAttributes.preview) {
    QuestLiveActivity()
  } contentStates: {
    QuestActivityContentState.previewRunning
    QuestActivityContentState.previewRunningNoProgress
    QuestActivityContentState.previewApproval
    QuestActivityContentState.previewPaused
    QuestActivityContentState.previewCompleted
    QuestActivityContentState.previewFailed
    QuestActivityContentState.previewStopped
  }

  #Preview("Compact", as: .dynamicIsland(.compact), using: QuestActivityAttributes.preview) {
    QuestLiveActivity()
  } contentStates: {
    QuestActivityContentState.previewRunning
    QuestActivityContentState.previewApproval
    QuestActivityContentState.previewCompleted
  }

  #Preview("Expanded", as: .dynamicIsland(.expanded), using: QuestActivityAttributes.preview) {
    QuestLiveActivity()
  } contentStates: {
    QuestActivityContentState.previewRunning
    QuestActivityContentState.previewApproval
    QuestActivityContentState.previewFailed
  }

  #Preview("Minimal", as: .dynamicIsland(.minimal), using: QuestActivityAttributes.preview) {
    QuestLiveActivity()
  } contentStates: {
    QuestActivityContentState.previewRunning
    QuestActivityContentState.previewCompleted
  }
#endif
