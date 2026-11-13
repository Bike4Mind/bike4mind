import B4MKit
import SwiftUI

/// The Studio gallery (code name: media): a grid of the user's generated images, video and audio.
struct MediaGalleryView: View {
  @Environment(AppServices.self) private var services

  var body: some View {
    GalleryContent(
      api: services.media, onLatestImage: services.latestGeneration, studio: services.studio,
      tracker: services.studioTracker)
  }
}

private struct GalleryContent: View {
  @State private var model: MediaGalleryViewModel
  @State private var create: StudioCreateViewModel
  /// Pushed with `navigationDestination(item:)`: the shell's stack is bound to a typed `SessionsDestination`
  /// path, so a `NavigationLink(value: MediaItem)` has nowhere to go and silently does nothing.
  @State private var openItem: MediaItem?
  @State private var turnInto: TurnIntoRequest?
  @Environment(AppServices.self) private var services
  private let tracker: GenerationTracker

  private let columns = [GridItem(.adaptive(minimum: 110), spacing: 2)]

  init(
    api: any MediaAPI, onLatestImage: @escaping @Sendable (MediaItem) async -> Void, studio: any StudioAPI,
    tracker: GenerationTracker
  ) {
    _model = State(initialValue: MediaGalleryViewModel(api: api, onLatestImage: onLatestImage))
    _create = State(initialValue: StudioCreateViewModel(api: studio, tracker: tracker))
    self.tracker = tracker
  }

  var body: some View {
    content
      .safeAreaInset(edge: .bottom, spacing: 0) {
        VStack(spacing: 0) {
          GenerationTilesView(tracker: tracker, settings: create)
          StudioCreateBar(model: create)
        }
      }
      // A finished generation is saved to the gallery server-side; pull it in.
      .onChange(of: tracker.succeededCount) { Task { await model.refresh() } }
      .background(Tokens.Palette.background)
      .navigationTitle("Studio")
      .navigationBarTitleDisplayMode(.large)
      .toolbar { ToolbarItem(placement: .principal) { filter } }
      .navigationDestination(item: $openItem) { item in
        MediaDetailView(item: item, api: services.media)
          .environment(\.studioEdit, editContext)
      }
      .turnIntoFlow(request: $turnInto, context: editContext)
      .task { await model.load() }
      .refreshable { await model.refresh() }
  }

  private var editContext: StudioEditContext {
    StudioEditContext(
      api: services.studio, media: services.media, tracker: tracker, frames: services.frameUploader,
      currentInputs: { create.videoInputs },
      apply: { seed in
        openItem = nil
        Task { await create.apply(seed) }
      })
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
        "Nothing created yet", systemImage: "photo.on.rectangle",
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
          Button {
            openItem = item
          } label: {
            MediaCell(item: item)
          }
          .buttonStyle(.plain)
          .contextMenu {
            TurnIntoButtons(item: item) { turnInto = $0 }
          }
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
        default: Tokens.Palette.groupedBackground
        }
      }
    case .video: placeholder("play.rectangle.fill")
    case .audio: placeholder("waveform")
    }
  }

  private func placeholder(_ symbol: String) -> some View {
    ZStack {
      Tokens.Palette.groupedBackground
      Image(systemName: symbol).font(.title).foregroundStyle(Tokens.Palette.secondaryText)
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
