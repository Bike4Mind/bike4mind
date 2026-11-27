import B4MKit
import SwiftUI

/// An image you can pinch to zoom, drag while zoomed, and double-tap to toggle between fit and 3x.
struct ZoomableImageView: View {
  let url: URL
  let onLoaded: @MainActor () -> Void
  let onFailure: @MainActor () async -> Void

  @State private var scale: CGFloat = 1
  @State private var committedScale: CGFloat = 1
  @State private var offset: CGSize = .zero
  @State private var committedOffset: CGSize = .zero

  private let range: ClosedRange<CGFloat> = 1...6

  @State private var loaded: (url: URL, image: CGImage)?
  @State private var failedURL: URL?

  var body: some View {
    Group {
      if let image {
        Image(image, scale: 1, label: Text("Generated image"))
          .resizable()
          .scaledToFit()
          .scaleEffect(scale)
          .offset(offset)
          .gesture(zoom.simultaneously(with: pan))
          .onTapGesture(count: 2) { toggleZoom() }
          .onAppear { onLoaded() }
          .accessibilityAddTraits(.isImage)
          .accessibilityIdentifier("media-zoomable-image")
          .accessibilityZoomAction { action in
            withAnimation(.easeInOut(duration: 0.2)) {
              let step: CGFloat = action.direction == .zoomIn ? 1.5 : 1 / 1.5
              scale = (scale * step).clamped(to: range)
              committedScale = scale
              if scale <= 1 { resetPan() }
            }
          }
      } else if failedURL == url {
        Color.clear.task { await onFailure() }
      } else {
        // The grid's thumbnail stands in until the full-size image arrives; the spinner stays so VoiceOver
        // and UI tests still see a loading state.
        ZStack {
          if let thumbnail = ThumbnailCache.shared.cachedImage(for: url) {
            Image(decorative: thumbnail, scale: 1).resizable().scaledToFit()
          }
          ProgressView().tint(.white)
        }
      }
    }
    .task(id: url) { await load() }
  }

  /// Read synchronously so a reopened image draws on its first frame, even under a re-signed URL.
  private var image: CGImage? {
    if let cached = ThumbnailCache.fullSize.cachedImage(for: url) { return cached }
    // Still drawn if NSCache evicted it while this view was on screen.
    return loaded?.url == url ? loaded?.image : nil
  }

  /// Lands every success in `loaded`: `body` reads NSCache, which SwiftUI does not observe.
  private func load() async {
    if let cached = ThumbnailCache.fullSize.cachedImage(for: url) {
      loaded = (url, cached)
      return
    }
    do {
      let image = try await ThumbnailCache.fullSize.image(for: url)
      guard !Task.isCancelled else { return }
      withAnimation(.easeOut(duration: 0.2)) { loaded = (url, image) }
    } catch {
      guard !Task.isCancelled else { return }
      failedURL = url
    }
  }

  private var zoom: some Gesture {
    MagnifyGesture()
      .onChanged { value in scale = (committedScale * value.magnification).clamped(to: range) }
      .onEnded { _ in
        committedScale = scale
        if scale <= 1 { resetPan() }
      }
  }

  private var pan: some Gesture {
    DragGesture()
      .onChanged { value in
        guard scale > 1 else { return }
        offset = CGSize(
          width: committedOffset.width + value.translation.width,
          height: committedOffset.height + value.translation.height)
      }
      .onEnded { _ in committedOffset = offset }
  }

  private func toggleZoom() {
    withAnimation(.easeInOut(duration: 0.2)) {
      if scale > 1 {
        scale = 1
        committedScale = 1
        resetPan()
      } else {
        scale = 3
        committedScale = 3
      }
    }
  }

  private func resetPan() {
    offset = .zero
    committedOffset = .zero
  }
}

extension Comparable {
  fileprivate func clamped(to range: ClosedRange<Self>) -> Self {
    min(max(self, range.lowerBound), range.upperBound)
  }
}
