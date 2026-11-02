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

  var body: some View {
    AsyncImage(url: url, transaction: Transaction(animation: .easeOut(duration: 0.2))) { phase in
      switch phase {
      case .success(let image):
        image
          .resizable()
          .scaledToFit()
          .scaleEffect(scale)
          .offset(offset)
          .gesture(zoom.simultaneously(with: pan))
          .onTapGesture(count: 2) { toggleZoom() }
          .onAppear { onLoaded() }
          .accessibilityLabel("Generated image")
          .accessibilityAddTraits(.isImage)
          .accessibilityIdentifier("media-zoomable-image")
      case .failure:
        Color.clear.task { await onFailure() }
      default:
        ProgressView().tint(.white)
      }
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
