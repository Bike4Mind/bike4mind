import B4MKit
import SwiftUI

/// The Media tab: a grid of the user's generated images, video and audio.
struct MediaGalleryView: View {
  @Environment(AppServices.self) private var services

  var body: some View {
    GalleryContent(api: services.media, onLatestImage: services.latestGeneration)
  }
}

private struct GalleryContent: View {
  @State private var model: MediaGalleryViewModel
  @Environment(AppServices.self) private var services

  private let columns = [GridItem(.adaptive(minimum: 110), spacing: 2)]

  init(api: any MediaAPI, onLatestImage: @escaping @Sendable (MediaItem) async -> Void) {
    _model = State(initialValue: MediaGalleryViewModel(api: api, onLatestImage: onLatestImage))
  }

  var body: some View {
    content
      .navigationTitle("Media")
      .toolbar { ToolbarItem(placement: .principal) { filter } }
      .navigationDestination(for: MediaItem.self) { item in
        MediaDetailView(item: item, api: services.media)
      }
      .task { await model.load() }
      .refreshable { await model.refresh() }
  }

  private var filter: some View {
    Picker("Type", selection: Binding(get: { model.kind }, set: { kind in Task { await model.select(kind: kind) } })) {
      Text("All").tag(MediaKind?.none)
      ForEach(MediaKind.allCases, id: \.self) { kind in Text(kind.title).tag(MediaKind?.some(kind)) }
    }
    .pickerStyle(.segmented)
    .frame(maxWidth: 320)
    .accessibilityIdentifier("media-filter")
  }

  @ViewBuilder
  private var content: some View {
    switch (model.state, model.items.isEmpty) {
    case (.idle, true), (.loading, true):
      ProgressView("Loading media")
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("media-loading")
    case (.failed(let error), true):
      ContentUnavailableView {
        Label("Couldn't load your media", systemImage: "wifi.exclamationmark")
      } description: {
        Text(error.message)
      } actions: {
        if error.isRetryable {
          Button("Try Again") { Task { await model.refresh() } }
            .buttonStyle(.borderedProminent)
        }
      }
    case (.loaded, true):
      ContentUnavailableView(
        "No media yet", systemImage: "photo.on.rectangle",
        description: Text(emptyMessage))
    default:
      grid
    }
  }

  private var emptyMessage: String {
    guard let kind = model.kind else { return "Images, video and music you generate will appear here." }
    return "No \(kind.title.lowercased()) generated yet."
  }

  private var grid: some View {
    ScrollView {
      if case .failed(let error) = model.state {
        InlineErrorBanner(message: error.message) { Task { await model.refresh() } }
          .padding(.horizontal, Tokens.Spacing.m)
      }
      LazyVGrid(columns: columns, spacing: 2) {
        ForEach(model.items) { item in
          NavigationLink(value: item) { MediaCell(item: item) }
            .buttonStyle(.plain)
            .task { await model.loadMoreIfNeeded(currentItem: item) }
            .accessibilityIdentifier("media-cell-\(item.id)")
        }
      }
      footer
    }
    .accessibilityIdentifier("media-grid")
  }

  @ViewBuilder
  private var footer: some View {
    if model.isLoadingMore {
      ProgressView().padding()
    } else if let error = model.loadMoreError {
      InlineErrorBanner(message: error.message) { Task { await model.loadMore() } }
        .padding(Tokens.Spacing.m)
    }
  }
}

private struct MediaCell: View {
  let item: MediaItem

  var body: some View {
    Color.clear
      .aspectRatio(1, contentMode: .fit)
      .overlay { tile }
      .clipped()
      .overlay(alignment: .bottomTrailing) { badge }
      .contentShape(Rectangle())
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("\(item.kind.accessibilityName), \(item.displayTitle)")
      .accessibilityHint("Opens full screen")
      .accessibilityAddTraits(.isButton)
  }

  @ViewBuilder
  private var tile: some View {
    switch item.kind {
    case .image:
      AsyncImage(url: item.url) { phase in
        switch phase {
        case .success(let image): image.resizable().scaledToFill()
        case .failure: placeholder("photo")
        default: Tokens.Palette.assistantBubble
        }
      }
    case .video: placeholder("play.rectangle.fill")
    case .audio: placeholder("waveform")
    }
  }

  private func placeholder(_ symbol: String) -> some View {
    ZStack {
      Tokens.Palette.assistantBubble
      Image(systemName: symbol).font(.title).foregroundStyle(.secondary)
    }
  }

  @ViewBuilder
  private var badge: some View {
    if item.kind != .image {
      Image(systemName: item.kind == .video ? "video.fill" : "music.note")
        .font(.caption2)
        .padding(5)
        .background(.ultraThinMaterial, in: Circle())
        .padding(4)
    }
  }
}

extension MediaKind {
  fileprivate var accessibilityName: String {
    switch self {
    case .image: "Image"
    case .video: "Video"
    case .audio: "Audio"
    }
  }
}
