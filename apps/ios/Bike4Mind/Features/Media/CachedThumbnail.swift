import B4MKit
import SwiftUI

/// A fill-cropped thumbnail backed by the session-wide `ThumbnailCache`. The cache is read synchronously in
/// `body`, so a lazy-grid cell that scrolls back into view draws its image on the first frame instead of
/// flashing its placeholder the way a bare `AsyncImage` does.
struct CachedThumbnail<Placeholder: View>: View {
  let url: URL?
  /// Receives `true` once loading has failed for `url`, `false` while it is missing or still loading.
  @ViewBuilder let placeholder: (_ failed: Bool) -> Placeholder

  @State private var loaded: (url: URL, image: CGImage)?
  @State private var failedURL: URL?

  var body: some View {
    Group {
      if let image {
        Image(decorative: image, scale: 1).resizable().scaledToFill()
      } else {
        placeholder(url != nil && failedURL == url)
      }
    }
    .task(id: url) { await load() }
  }

  private var image: CGImage? {
    guard let url else { return nil }
    if let cached = ThumbnailCache.shared.cachedImage(for: url) { return cached }
    // Still drawn if NSCache evicted it while this view was on screen.
    return loaded?.url == url ? loaded?.image : nil
  }

  private func load() async {
    guard let url, ThumbnailCache.shared.cachedImage(for: url) == nil else { return }
    do {
      loaded = (url, try await ThumbnailCache.shared.image(for: url))
      failedURL = nil
    } catch {
      failedURL = url
    }
  }
}

extension CachedThumbnail where Placeholder == Color {
  /// A thumbnail that shows the grouped background until it loads, and if it never does.
  init(url: URL?) {
    self.init(url: url) { _ in Tokens.Palette.groupedBackground }
  }
}
