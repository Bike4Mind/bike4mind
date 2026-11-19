import CoreGraphics
import Foundation
import ImageIO

/// Decoded, downsampled thumbnails kept for the session. A lazy grid destroys off-screen cells, so a cell
/// that scrolls back into view reads `cachedImage(for:)` synchronously and draws on its first frame instead
/// of starting empty and refetching.
///
/// Keys drop the query string: a presigned or `/content` URL is re-signed every window, but its path (the
/// storage key or file id) names the same immutable file.
public final class ThumbnailCache: @unchecked Sendable {
  public static let shared = ThumbnailCache()

  /// Covers a 3x grid cell on the largest adaptive column without decoding a multi-megapixel original.
  public static let defaultMaxPixelSize = 600

  public let maxPixelSize: Int
  private let downloader: any ImageDownloading
  private let images = NSCache<NSString, Entry>()
  // Guards `inFlight`; NSCache is already thread-safe.
  private let lock = NSLock()
  private var inFlight: [String: Task<Entry, any Error>] = [:]

  /// - Parameter costLimitBytes: decoded bitmap bytes kept before NSCache starts evicting; it also evicts on
  ///   memory pressure.
  public init(
    downloader: any ImageDownloading = URLSessionImageDownloader(), maxPixelSize: Int = defaultMaxPixelSize,
    costLimitBytes: Int = 128 * 1024 * 1024
  ) {
    self.downloader = downloader
    self.maxPixelSize = maxPixelSize
    images.totalCostLimit = costLimitBytes
  }

  public static func key(for url: URL) -> String {
    guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url.absoluteString }
    components.query = nil
    components.fragment = nil
    return components.string ?? url.absoluteString
  }

  public func cachedImage(for url: URL) -> CGImage? {
    images.object(forKey: Self.key(for: url) as NSString)?.image
  }

  /// The cached thumbnail, or a fresh download shared with any caller already waiting on the same file.
  /// The download is not cancelled with the caller, so a cell scrolled away mid-load still fills the cache.
  public func image(for url: URL) async throws -> CGImage {
    if let cached = cachedImage(for: url) { return cached }
    let key = Self.key(for: url)
    let task = lock.withLock {
      if let running = inFlight[key] { return running }
      let running = Task.detached(priority: .userInitiated) { [downloader, maxPixelSize] in
        let data = try await downloader.download(url)
        guard let image = Self.decode(data, maxPixelSize: maxPixelSize) else {
          throw URLError(.cannotDecodeContentData)
        }
        return Entry(image)
      }
      inFlight[key] = running
      return running
    }
    do {
      let entry = try await task.value
      store(entry, key: key)
      return entry.image
    } catch {
      _ = lock.withLock { inFlight.removeValue(forKey: key) }
      throw error
    }
  }

  private func store(_ entry: Entry, key: String) {
    images.setObject(entry, forKey: key as NSString, cost: entry.image.bytesPerRow * entry.image.height)
    _ = lock.withLock { inFlight.removeValue(forKey: key) }
  }

  static func decode(_ data: Data, maxPixelSize: Int) -> CGImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
      // Decode here, off the main thread, rather than lazily on the first draw.
      kCGImageSourceShouldCacheImmediately: true,
    ]
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
  }

  /// NSCache needs a class value, and the Task result needs to be Sendable; a CGImage is immutable.
  private final class Entry: @unchecked Sendable {
    let image: CGImage
    init(_ image: CGImage) { self.image = image }
  }
}
