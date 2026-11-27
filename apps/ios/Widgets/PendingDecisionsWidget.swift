import B4MKit
import SwiftUI
import WidgetKit

struct PendingDecisionsEntry: TimelineEntry {
  let date: Date
  let display: PendingDecisionsDisplay
}

struct PendingDecisionsProvider: TimelineProvider {
  func placeholder(in context: Context) -> PendingDecisionsEntry {
    PendingDecisionsEntry(date: Date(), display: .count(3))
  }

  func getSnapshot(in context: Context, completion: @escaping (PendingDecisionsEntry) -> Void) {
    if context.isPreview {
      completion(placeholder(in: context))
      return
    }
    let now = Date()
    completion(PendingDecisionsEntry(date: now, display: WidgetData.mapper(now: now).pendingDecisions()))
  }

  // The app reloads this widget whenever it reads a new count; the planned refresh drops lapsed approvals.
  func getTimeline(in context: Context, completion: @escaping (Timeline<PendingDecisionsEntry>) -> Void) {
    let now = Date()
    let mapper = WidgetData.mapper(now: now)
    completion(
      Timeline(
        entries: [PendingDecisionsEntry(date: now, display: mapper.pendingDecisions())],
        policy: .after(mapper.nextRefresh())))
  }
}

/// Decisions, not unreads: one number on the lock screen.
struct PendingDecisionsWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: WidgetKind.pendingDecisions, provider: PendingDecisionsProvider()) { entry in
      PendingDecisionsView(entry: entry)
        .widgetBackground()
    }
    .configurationDisplayName("Decisions waiting")
    .description("How many decisions are waiting on you.")
    .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline])
  }
}

struct PendingDecisionsView: View {
  @Environment(\.widgetFamily) private var family
  let entry: PendingDecisionsEntry

  var body: some View {
    content
      .widgetURL(WidgetDestination.latestBrief)
  }

  @ViewBuilder
  private var content: some View {
    switch family {
    case .accessoryRectangular: rectangular
    case .accessoryInline: inline
    default: circular
    }
  }

  @ViewBuilder
  private var circular: some View {
    switch entry.display {
    case .count(let count):
      VStack(spacing: 0) {
        Image(systemName: "checklist").font(.caption2)
        Text("\(count)").font(.system(.title3, design: .rounded, weight: .bold)).monospacedDigit()
      }
      .accessibilityLabel(Self.label(count))
    case .placeholder:
      Image(systemName: "checklist")
    }
  }

  @ViewBuilder
  private var rectangular: some View {
    switch entry.display {
    case .count(let count):
      VStack(alignment: .leading, spacing: 2) {
        Label("Decisions", systemImage: "checklist").font(.caption)
        Text("\(count)").font(.system(.title2, design: .rounded, weight: .bold)).monospacedDigit()
        Text(count == 0 ? "Nothing needs you" : "waiting on you").font(.caption2).foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(Self.label(count))
    case .placeholder:
      Label("Open Bike4Mind", systemImage: "checklist").font(.headline)
    }
  }

  @ViewBuilder
  private var inline: some View {
    switch entry.display {
    case .count(let count): Label(Self.label(count), systemImage: "checklist")
    case .placeholder: Label("Bike4Mind decisions", systemImage: "checklist")
    }
  }

  private static func label(_ count: Int) -> String {
    count == 1 ? "1 decision waiting" : "\(count) decisions waiting"
  }
}

#Preview("Lock circular", as: .accessoryCircular) {
  PendingDecisionsWidget()
} timeline: {
  PendingDecisionsEntry(date: .now, display: WidgetEntryMapper(snapshot: .fixture(), now: .now).pendingDecisions())
  PendingDecisionsEntry(date: .now, display: .placeholder)
}

#Preview("Lock rectangular", as: .accessoryRectangular) {
  PendingDecisionsWidget()
} timeline: {
  PendingDecisionsEntry(date: .now, display: WidgetEntryMapper(snapshot: .fixture(), now: .now).pendingDecisions())
  PendingDecisionsEntry(date: .now, display: .count(0))
}
