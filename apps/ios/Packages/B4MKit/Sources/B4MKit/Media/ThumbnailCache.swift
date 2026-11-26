import CoreGraphics
import Foundation
import ImageIO

/// Decoded, downsampled images kept for the session, in two tiers with separate budgets: `shared` for grid
/// thumbnails and `fullSize` for the full-screen viewer and region editing. A lazy grid destroys off-screen
/// cells, so a cell that scrolls back into view reads `cachedImage(for:)` synchronously and draws on its first
/// frame instead of starting empty and refetching.
///
/// Keys drop the query string: a presigned or `/content` URL is re-signed every window, but its path (the
/// storage key or file id) names the same immutable file.
public final class ThumbnailCache: @unchecked Sendable {
  public static let shared = ThumbnailCache()

  /// Full-size images. The disk layer keeps the original bytes across launches, so reopening an image the
  /// memory tier has evicted re-decodes instead of downloading again.
  public static let fullSize = ThumbnailCache(
    maxPixelSize: fullSizeMaxPixelSize, costLimitBytes: 96 * 1024 * 1024,
    disk: ImageDiskStore(
      directory: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("FullSizeImages", isDirectory: true),
      byteLimit: 150 * 1024 * 1024))

  /// Covers a 3x grid cell on the largest adaptive column without decoding a multi-megapixel original.
  public static let defaultMaxPixelSize = 600

  /// Past any generated image's size, but caps the bitmap (64 MB at this size) of an unusually large upload.
  public static let fullSizeMaxPixelSize = 4096

  public let maxPixelSize: Int
  private let downloader: any ImageDownloading
  private let disk: ImageDiskStore?
  private let images = NSCache<NSString, Entry>()
  // Guards `inFlight` and `nextFlightID`; NSCache is already thread-safe.
  private let lock = NSLock()
  private var inFlight: [String: Flight] = [:]
  private var nextFlightID: UInt64 = 0

  /// - Parameters:
  ///   - costLimitBytes: decoded bitmap bytes kept before NSCache starts evicting; it also evicts on memory
  ///     pressure.
  ///   - disk: where original bytes are read from before downloading, and written to after a download decodes.
  public init(
    downloader: any ImageDownloading = URLSessionThumbnailDownloader(), maxPixelSize: Int = defaultMaxPixelSize,
    costLimitBytes: Int = 128 * 1024 * 1024, disk: ImageDiskStore? = nil
  ) {
    self.downloader = downloader
    self.maxPixelSize = maxPixelSize
    self.disk = disk
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

  /// The cached thumbnail, or a download shared with every caller waiting on the same file. The download is
  /// cancelled once all of its callers are, so a fast scroll does not queue fetches for cells already gone.
  public func image(for url: URL) async throws -> CGImage {
    if let cached = cachedImage(for: url) { return cached }
    let key = Self.key(for: url)
    let (id, task) = join(key: key, url: url)
    return try await withTaskCancellationHandler {
      try await task.value.image
    } onCancel: {
      leave(key: key, id: id)
    }
  }

  /// Drops every image, on disk too, and cancels every download, so nothing from the previous account outlives
  /// a sign-out.
  public func removeAll() {
    let running = lock.withLock {
      defer { inFlight.removeAll() }
      return inFlight.values.map(\.task)
    }
    running.forEach { $0.cancel() }
    images.removeAllObjects()
    disk?.removeAll()
  }

  /// How many callers are waiting on the download for `url`; 0 when none is running. For tests.
  func waiterCount(for url: URL) -> Int {
    lock.withLock { inFlight[Self.key(for: url)]?.waiters ?? 0 }
  }

  private func join(key: String, url: URL) -> (UInt64, Task<Entry, any Error>) {
    lock.withLock {
      if var flight = inFlight[key] {
        flight.waiters += 1
        inFlight[key] = flight
        return (flight.id, flight.task)
      }
      nextFlightID += 1
      let id = nextFlightID
      // `finish` takes the lock, so it cannot run before this flight is registered below.
      let task = Task.detached(priority: .userInitiated) { [self] in
        defer { finish(key: key, id: id) }
        let image = try await load(key: key, url: url)
        // A `removeAll` during the decode must not let this image land in the emptied cache.
        try Task.checkCancellation()
        let entry = Entry(image)
        images.setObject(entry, forKey: key as NSString, cost: image.bytesPerRow * image.height)
        return entry
      }
      inFlight[key] = Flight(id: id, task: task, waiters: 1)
      return (id, task)
    }
  }

  /// Decodes the stored bytes when the disk layer has them, else downloads. Only bytes that decode are
  /// stored, so an error page served with a 2xx is never kept.
  private func load(key: String, url: URL) async throws -> CGImage {
    let generation = disk?.generation
    if let disk, let stored = disk.data(for: key) {
      if let image = Self.decode(stored, maxPixelSize: maxPixelSize) { return image }
      disk.remove(for: key)
    }
    let data = try await downloader.download(url)
    try Task.checkCancellation()
    guard let image = Self.decode(data, maxPixelSize: maxPixelSize) else {
      throw URLError(.cannotDecodeContentData)
    }
    if let disk, let generation { disk.store(data, for: key, generation: generation) }
    return image
  }

  /// A waiter was cancelled; the last one out cancels the download. The id check keeps a late call from
  /// touching a newer flight for the same key.
  private func leave(key: String, id: UInt64) {
    let abandoned: Task<Entry, any Error>? = lock.withLock {
      guard var flight = inFlight[key], flight.id == id else { return nil }
      flight.waiters -= 1
      guard flight.waiters == 0 else {
        inFlight[key] = flight
        return nil
      }
      inFlight.removeValue(forKey: key)
      return flight.task
    }
    abandoned?.cancel()
  }

  private func finish(key: String, id: UInt64) {
    lock.withLock {
      if inFlight[key]?.id == id { inFlight.removeValue(forKey: key) }
    }
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

  private struct Flight {
    let id: UInt64
    let task: Task<Entry, any Error>
    var waiters: Int
  }

  /// NSCache needs a class value, and the Task result needs to be Sendable; a CGImage is immutable.
  private final class Entry: @unchecked Sendable {
    let image: CGImage
    init(_ image: CGImage) { self.image = image }
  }
}

/// Fetches a grid image in one bulk transfer and accepts any 2xx. Unlike `URLSessionImageDownloader` (built
/// for the widget), it has no size cap: a thumbnail must show whatever the full-screen view can.
public struct URLSessionThumbnailDownloader: ImageDownloading {
  private let session: URLSession

  public init(session: URLSession = .shared) {
    self.session = session
  }

  public func download(_ url: URL) async throws -> Data {
    let (data, response) = try await session.data(from: url)
    guard let status = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status) else {
      throw URLError(.badServerResponse)
    }
    return data
  }
}
