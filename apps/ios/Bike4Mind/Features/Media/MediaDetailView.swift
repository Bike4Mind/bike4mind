import B4MKit
import SwiftUI

/// One generated file full screen: a zoomable image, or a video/audio player with AirPlay and
/// picture-in-picture. Storage URLs are short-lived, so the view model refetches the detail when one
/// lapses or fails to load.
struct MediaDetailView: View {
  @State private var model: MediaDetailViewModel

  init(item: MediaItem, api: any MediaAPI) {
    _model = State(initialValue: MediaDetailViewModel(item: item, api: api))
  }

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
      content
    }
    .navigationTitle(model.item.displayTitle)
    .navigationBarTitleDisplayMode(.inline)
    .toolbarBackground(.visible, for: .navigationBar)
    .task { await model.prepare() }
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
