import AppIntents
import B4MKit
import SwiftUI
import WidgetKit

/// The one configurable widget: whether the image carries a caption.
struct LatestGenerationConfigurationIntent: WidgetConfigurationIntent {
  static let title: LocalizedStringResource = "Latest generation"
  static let description = IntentDescription("Shows your most recent generated image.")

  @Parameter(title: "Show caption", default: true)
  var showsCaption: Bool
}

struct LatestGenerationEntry: TimelineEntry {
  let date: Date
  let display: LatestGenerationDisplay
  let showsCaption: Bool
}

struct LatestGenerationProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> LatestGenerationEntry {
    LatestGenerationEntry(date: Date(), display: .placeholder, showsCaption: true)
  }

  func snapshot(
    for configuration: LatestGenerationConfigurationIntent, in context: Context
  ) async
    -> LatestGenerationEntry
  {
    entry(for: configuration, preview: context.isPreview)
  }

  func timeline(
    for configuration: LatestGenerationConfigurationIntent, in context: Context
  ) async
    -> Timeline<LatestGenerationEntry>
  {
    // The app reloads this widget when a newer generation lands; no scheduled refresh is needed.
    Timeline(entries: [entry(for: configuration, preview: false)], policy: .never)
  }

  private func entry(for configuration: LatestGenerationConfigurationIntent, preview: Bool) -> LatestGenerationEntry {
    let now = Date()
    let snapshot = preview ? WidgetSnapshot.fixture(now: now) : WidgetData.store().load()
    return LatestGenerationEntry(
      date: now, display: WidgetEntryMapper(snapshot: snapshot, now: now).latestGeneration(),
      showsCaption: configuration.showsCaption)
  }
}

struct LatestGenerationWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(
      kind: WidgetKind.latestGeneration, intent: LatestGenerationConfigurationIntent.self,
      provider: LatestGenerationProvider()
    ) { entry in
      LatestGenerationView(entry: entry)
        .widgetBackground()
    }
    .configurationDisplayName("Latest generation")
    .description("Your most recent generated image.")
    .supportedFamilies([.systemSmall, .systemMedium])
    .contentMarginsDisabled()
  }
}

struct LatestGenerationView: View {
  let entry: LatestGenerationEntry

  var body: some View {
    content
      .widgetURL(WidgetDestination.media)
  }

  @ViewBuilder
  private var content: some View {
    switch entry.display {
    case .image(_, let title, let thumbnailFileName, _):
      ZStack(alignment: .bottomLeading) {
        thumbnail(fileName: thumbnailFileName)
        if entry.showsCaption {
          Text(title)
            .font(.caption.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.ultraThinMaterial)
        }
      }
    case .placeholder:
      VStack(spacing: 6) {
        Image(systemName: "photo.on.rectangle").font(.title2).foregroundStyle(.tint)
        Text("No generations yet").font(.subheadline.weight(.semibold))
        Text(WidgetStyle.placeholderMessage).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
      }
      .padding()
    }
  }

  @ViewBuilder
  private func thumbnail(fileName: String?) -> some View {
    let image = fileName.flatMap { WidgetData.store().thumbnailURL(fileName: $0) }
      .flatMap { UIImage(contentsOfFile: $0.path()) }
    if let image {
      Color.clear
        .overlay { Image(uiImage: image).resizable().scaledToFill() }
        .clipped()
    } else {
      ZStack {
        LinearGradient(
          colors: [.accentColor.opacity(0.35), .accentColor.opacity(0.1)], startPoint: .topLeading,
          endPoint: .bottomTrailing)
        Image(systemName: "photo").font(.largeTitle).foregroundStyle(.secondary)
      }
    }
  }
}

#Preview("Small", as: .systemSmall) {
  LatestGenerationWidget()
} timeline: {
  LatestGenerationEntry(
    date: .now, display: WidgetEntryMapper(snapshot: .fixture(), now: .now).latestGeneration(), showsCaption: true)
  LatestGenerationEntry(date: .now, display: .placeholder, showsCaption: true)
}

#Preview("Medium", as: .systemMedium) {
  LatestGenerationWidget()
} timeline: {
  LatestGenerationEntry(
    date: .now, display: WidgetEntryMapper(snapshot: .fixture(), now: .now).latestGeneration(), showsCaption: false)
}
