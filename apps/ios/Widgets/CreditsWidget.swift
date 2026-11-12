import B4MKit
import SwiftUI
import WidgetKit

struct CreditsEntry: TimelineEntry {
  let date: Date
  let display: CreditsDisplay
}

struct CreditsProvider: TimelineProvider {
  func placeholder(in context: Context) -> CreditsEntry {
    CreditsEntry(date: Date(), display: .balance(formatted: "31,667", value: 31_667, isStale: false))
  }

  func getSnapshot(in context: Context, completion: @escaping (CreditsEntry) -> Void) {
    if context.isPreview {
      completion(placeholder(in: context))
      return
    }
    let now = Date()
    completion(CreditsEntry(date: now, display: WidgetData.mapper(now: now).credits()))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<CreditsEntry>) -> Void) {
    let now = Date()
    let mapper = WidgetData.mapper(now: now)
    // The app reloads this widget whenever it learns a new balance; the hourly refresh only re-evaluates staleness.
    completion(
      Timeline(entries: [CreditsEntry(date: now, display: mapper.credits())], policy: .after(mapper.nextRefresh())))
  }
}

struct CreditsWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: WidgetKind.credits, provider: CreditsProvider()) { entry in
      CreditsView(entry: entry)
        .widgetBackground()
    }
    .configurationDisplayName("Credits")
    .description("Your current credit balance.")
    .supportedFamilies([.systemSmall, .accessoryCircular, .accessoryRectangular, .accessoryInline])
  }
}

struct CreditsView: View {
  @Environment(\.widgetFamily) private var family
  let entry: CreditsEntry

  var body: some View {
    content
      .widgetURL(WidgetDestination.settings)
  }

  @ViewBuilder
  private var content: some View {
    switch family {
    case .accessoryCircular: circular
    case .accessoryRectangular: rectangular
    case .accessoryInline: inline
    default: home
    }
  }

  @ViewBuilder
  private var circular: some View {
    switch entry.display {
    case .balance(_, let value, _):
      VStack(spacing: 0) {
        Image(systemName: "creditcard").font(.caption2)
        Text(CreditsFormat.compact(value)).font(.system(.body, design: .rounded, weight: .semibold)).minimumScaleFactor(
          0.6)
      }
    case .placeholder:
      Image(systemName: "creditcard")
    }
  }

  @ViewBuilder
  private var rectangular: some View {
    switch entry.display {
    case .balance(let formatted, _, let isStale):
      VStack(alignment: .leading, spacing: 2) {
        Label("Credits", systemImage: "creditcard").font(.caption)
        Text(formatted).font(.system(.title2, design: .rounded, weight: .bold)).monospacedDigit()
        if isStale { Text("May be out of date").font(.caption2).foregroundStyle(.secondary) }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    case .placeholder:
      Label("Open Bike4Mind", systemImage: "creditcard").font(.headline)
    }
  }

  @ViewBuilder
  private var inline: some View {
    switch entry.display {
    case .balance(let formatted, _, _): Label("\(formatted) credits", systemImage: "creditcard")
    case .placeholder: Label("Bike4Mind credits", systemImage: "creditcard")
    }
  }

  @ViewBuilder
  private var home: some View {
    switch entry.display {
    case .balance(let formatted, _, let isStale):
      VStack(alignment: .leading, spacing: 4) {
        WidgetStyle.title("Credits")
        Spacer(minLength: 0)
        Text(formatted)
          .font(.system(size: 36, weight: .bold, design: .rounded))
          .monospacedDigit()
          .minimumScaleFactor(0.5)
          .lineLimit(1)
          .foregroundStyle(.tint)
        Text(isStale ? "May be out of date" : "available").font(.caption).foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    case .placeholder:
      VStack(alignment: .leading, spacing: 6) {
        Image(systemName: "creditcard").font(.title2).foregroundStyle(.tint)
        Text("Credits").font(.subheadline.weight(.semibold))
        Text(WidgetStyle.placeholderMessage).font(.caption).foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
  }
}

#Preview("Home", as: .systemSmall) {
  CreditsWidget()
} timeline: {
  CreditsEntry(date: .now, display: WidgetEntryMapper(snapshot: .fixture(), now: .now).credits())
  CreditsEntry(date: .now, display: .balance(formatted: "31,667", value: 31_667, isStale: true))
  CreditsEntry(date: .now, display: .placeholder)
}

#Preview("Lock circular", as: .accessoryCircular) {
  CreditsWidget()
} timeline: {
  CreditsEntry(date: .now, display: WidgetEntryMapper(snapshot: .fixture(), now: .now).credits())
}

#Preview("Lock rectangular", as: .accessoryRectangular) {
  CreditsWidget()
} timeline: {
  CreditsEntry(date: .now, display: WidgetEntryMapper(snapshot: .fixture(), now: .now).credits())
}
