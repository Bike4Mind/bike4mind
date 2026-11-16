import B4MKit
import SwiftUI

/// One generated file full screen: a zoomable image, or a video/audio player with AirPlay and
/// picture-in-picture. Storage URLs are short-lived, so the view model refetches the detail when one
/// lapses or fails to load.
struct MediaDetailView: View {
  @State private var model: MediaDetailViewModel
  @State private var isEditing = false
  @State private var turnInto: TurnIntoRequest?
  @State private var lineage: LineageViewModel
  @State private var opened: MediaItem?
  @Environment(\.studioEdit) private var studioEdit
  private let api: any MediaAPI

  init(item: MediaItem, api: any MediaAPI) {
    self.api = api
    _model = State(initialValue: MediaDetailViewModel(item: item, api: api))
    _lineage = State(initialValue: LineageViewModel(fileID: item.id, api: api))
  }

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
      content
    }
    .navigationTitle(model.item.displayTitle)
    .navigationBarTitleDisplayMode(.inline)
    .toolbarBackground(.visible, for: .navigationBar)
    .toolbar {
      if model.item.kind == .image, model.state == .ready, studioEdit != nil {
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            isEditing = true
          } label: {
            Label("Edit regions", systemImage: "rectangle.dashed")
          }
          .accessibilityIdentifier("media-edit-btn")
        }
      }
      if model.state == .ready, studioEdit != nil, !TurnInto.actions(for: model.item).isEmpty {
        ToolbarItem(placement: .topBarTrailing) {
          Menu {
            TurnIntoButtons(item: model.item) { turnInto = $0 }
          } label: {
            Label("Turn into...", systemImage: "wand.and.stars")
          }
          .accessibilityIdentifier("media-turn-into-btn")
        }
      }
      if let url = model.item.url {
        ToolbarItem(placement: .topBarTrailing) {
          // The bytes are not on disk (AsyncImage and AVPlayer stream the signed URL), so the link is what is shared.
          ShareLink(item: url)
            .accessibilityIdentifier("media-share-btn")
        }
      }
    }
    .task { await model.prepare() }
    .task { await lineage.load() }
    .safeAreaInset(edge: .bottom, spacing: 0) { lineageChips }
    .navigationDestination(item: $opened) { MediaDetailView(item: $0, api: api) }
    .turnIntoFlow(request: $turnInto, context: studioEdit)
    .fullScreenCover(isPresented: $isEditing) {
      if let studioEdit {
        RegionEditView(item: model.item, api: studioEdit.api, media: studioEdit.media, tracker: studioEdit.tracker)
      }
    }
  }

  @ViewBuilder
  private var lineageChips: some View {
    if let trail = lineage.lineage, !trail.isEmpty || branchSeed(in: trail) != nil {
      LineageChipsView(
        lineage: trail, onOpen: { opened = $0.mediaItem },
        onBranch: branchSeed(in: trail).map { seed in { studioEdit?.apply(seed) } })
    }
  }

  /// Branch needs the create bar (Studio) and a node Studio can re-run.
  private func branchSeed(in trail: FileLineage) -> StudioSeed? {
    guard studioEdit != nil, let root = trail.root else { return nil }
    return LineageBranch.seed(for: root, parents: trail.madeFrom)
  }

  @ViewBuilder
  private var content: some View {
    switch model.state {
    case .refreshing:
      ProgressView().tint(.white)
    case .failed(let error):
      ContentUnavailableView {
        Label("Couldn't open this file", systemImage: "exclamationmark.triangle")
      } description: {
        Text(error == .malformedResponse ? "The link to this file expired." : error.message)
      } actions: {
        Button("Try Again") { Task { await model.retry() } }
          .buttonStyle(.borderedProminent)
      }
      .environment(\.colorScheme, .dark)
    case .ready:
      media
    }
  }

  @ViewBuilder
  private var media: some View {
    if let url = model.item.url {
      switch model.item.kind {
      case .image:
        ZoomableImageView(url: url, onLoaded: model.playbackSucceeded) { _ = await model.playbackFailed() }
          .id(url)
      case .video, .audio:
        MediaPlayerView(
          url: url, onReady: model.playbackSucceeded, onFailure: { Task { _ = await model.playbackFailed() } }
        )
        .ignoresSafeArea(edges: .bottom)
        .id(url)
      }
    } else {
      ContentUnavailableView(
        "Not available", systemImage: "eye.slash", description: Text("This file is still being processed.")
      )
      .environment(\.colorScheme, .dark)
    }
  }
}
