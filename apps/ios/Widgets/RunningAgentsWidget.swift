import B4MKit
import SwiftUI
import WidgetKit

struct RunningAgentsEntry: TimelineEntry {
  let date: Date
  let display: RunningAgentsDisplay
}

struct RunningAgentsProvider: TimelineProvider {
  func placeholder(in context: Context) -> RunningAgentsEntry {
    RunningAgentsEntry(
      date: Date(),
      display: .active(count: 2, topTitle: "Quarterly metrics review", topStatus: "Working", sessionID: nil))
  }

  func getSnapshot(in context: Context, completion: @escaping (RunningAgentsEntry) -> Void) {
    if context.isPreview {
      completion(placeholder(in: context))
      return
    }
    let now = Date()
    completion(RunningAgentsEntry(date: now, display: WidgetData.mapper(now: now).runningAgents()))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<RunningAgentsEntry>) -> Void) {
    let now = Date()
    let snapshot = WidgetData.store().load()
    let next = WidgetEntryMapper(snapshot: snapshot, now: now).nextRefresh()
    // A second entry at `next` lets the widget flip to "stale" on its own instead of showing agents
    // that finished long ago.
    let entries = [now, next].map {
      RunningAgentsEntry(date: $0, display: WidgetEntryMapper(snapshot: snapshot, now: $0).runningAgents())
    }
    completion(Timeline(entries: entries, policy: .after(next)))
  }
}

struct RunningAgentsWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: WidgetKind.runningAgents, provider: RunningAgentsProvider()) { entry in
      RunningAgentsView(entry: entry)
        .widgetBackground()
    }
    .configurationDisplayName("Running agents")
    .description("See how many agents are working and what the top one is doing.")
    .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryInline])
  }
}

struct RunningAgentsView: View {
  @Environment(\.widgetFamily) private var family
  let entry: RunningAgentsEntry

  var body: some View {
    content
      .widgetURL(destination)
  }

  private var destination: URL {
    if case .active(_, _, _, let sessionID?) = entry.display { return WidgetDestination.session(sessionID) }
    return WidgetDestination.sessions
  }

  @ViewBuilder
  private var content: some View {
    switch family {
    case .accessoryInline: inline
    case .accessoryRectangular: rectangular
    default: home
    }
  }

  @ViewBuilder
  private var inline: some View {
    switch entry.display {
    case .active(let count, _, _, _): Label("\(count) running", systemImage: "bolt.horizontal.circle")
    case .idle: Label("No agents running", systemImage: "moon.zzz")
    case .placeholder, .stale: Label("Bike4Mind", systemImage: "bolt.horizontal.circle")
    }
  }

  @ViewBuilder
  private var rectangular: some View {
    switch entry.display {
    case .active(let count, let title, let status, _):
      VStack(alignment: .leading, spacing: 2) {
        Label("\(count) running", systemImage: "bolt.horizontal.circle").font(.headline)
        Text(title).font(.caption).lineLimit(1)
        Text(status).font(.caption2).foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    case .idle:
      Label("No agents running", systemImage: "moon.zzz").font(.headline)
    case .stale:
      Label("Open to refresh", systemImage: "arrow.clockwise").font(.headline)
    case .placeholder:
      Label("Bike4Mind", systemImage: "bolt.horizontal.circle").font(.headline)
    }
  }

  @ViewBuilder
  private var home: some View {
    switch entry.display {
    case .active(let count, let title, let status, _):
      VStack(alignment: .leading, spacing: 4) {
        WidgetStyle.title("Running agents")
        Text("\(count)")
          .font(.system(size: family == .systemSmall ? 44 : 52, weight: .bold, design: .rounded))
          .foregroundStyle(.tint)
          .contentTransition(.numericText())
        Spacer(minLength: 0)
        Text(title).font(.subheadline.weight(.semibold)).lineLimit(family == .systemSmall ? 2 : 1)
        Text(status).font(.caption).foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    case .idle:
      message("No agents running", detail: "Start a quest and it shows up here.", symbol: "moon.zzz")
    case .stale:
      message(
        "Open Bike4Mind", detail: "Running agents are only tracked while the app is open.", symbol: "arrow.clockwise")
    case .placeholder:
      message("Running agents", detail: WidgetStyle.placeholderMessage, symbol: "bolt.horizontal.circle")
    }
  }

  private func message(_ title: String, detail: String, symbol: String) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Image(systemName: symbol).font(.title2).foregroundStyle(.tint)
      Text(title).font(.subheadline.weight(.semibold))
      Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(3)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }
}

#Preview("Active", as: .systemSmall) {
  RunningAgentsWidget()
} timeline: {
  RunningAgentsEntry(date: .now, display: WidgetEntryMapper(snapshot: .fixture(), now: .now).runningAgents())
}

#Preview("Medium", as: .systemMedium) {
  RunningAgentsWidget()
} timeline: {
  RunningAgentsEntry(date: .now, display: WidgetEntryMapper(snapshot: .fixture(), now: .now).runningAgents())
}

#Preview("Lock screen", as: .accessoryRectangular) {
  RunningAgentsWidget()
} timeline: {
  RunningAgentsEntry(date: .now, display: WidgetEntryMapper(snapshot: .fixture(), now: .now).runningAgents())
}

#Preview("Idle", as: .systemSmall) {
  RunningAgentsWidget()
} timeline: {
  RunningAgentsEntry(date: .now, display: .idle)
  RunningAgentsEntry(date: .now, display: .stale(observedAt: .now.addingTimeInterval(-3_600)))
  RunningAgentsEntry(date: .now, display: .placeholder)
}
