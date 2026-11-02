import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Shrinks a downloaded image to something a widget can afford to draw. Widgets have a small memory
/// ceiling, so the app hands them a ~600 px JPEG instead of the full-size generation.
public enum ThumbnailEncoder {
  public static let defaultMaxPixelSize = 600

  /// - Returns: JPEG bytes whose longest side is at most `maxPixelSize`, or `nil` if `data` is not an image.
  public static func jpegThumbnail(from data: Data, maxPixelSize: Int = defaultMaxPixelSize) -> Data? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
    let output = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil)
    else { return nil }
    CGImageDestinationAddImage(
      destination, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
    return CGImageDestinationFinalize(destination) ? output as Data : nil
  }
}

/// Downloads an image's bytes. Presigned URLs carry their own credentials, so no bearer is attached.
public protocol ImageDownloading: Sendable {
  func download(_ url: URL) async throws -> Data
}

public struct URLSessionImageDownloader: ImageDownloading {
  /// A hard ceiling so a surprise 200 MB file cannot be pulled into memory just for a widget.
  public static let maxBytes = 20 * 1024 * 1024

  private let session: URLSession

  public init(session: URLSession = .shared) {
    self.session = session
  }

  public func download(_ url: URL) async throws -> Data {
    let (data, response) = try await session.data(from: url)
    guard (response as? HTTPURLResponse)?.statusCode == 200, data.count <= Self.maxBytes else {
      throw URLError(.badServerResponse)
    }
    return data
  }
}

/// Keeps the "Latest generation" widget current: when the gallery learns of a newer image, fetch,
/// shrink and record it. Failures leave the previous widget content untouched.
public struct LatestGenerationPublisher: Sendable {
  private let recorder: WidgetSnapshotRecorder
  private let downloader: any ImageDownloading

  public init(recorder: WidgetSnapshotRecorder, downloader: any ImageDownloading = URLSessionImageDownloader()) {
    self.recorder = recorder
    self.downloader = downloader
  }

  public func publish(_ item: MediaItem) async {
    guard item.kind == .image else { return }
    var thumbnail: Data?
    if let url = item.url, let bytes = try? await downloader.download(url) {
      thumbnail = ThumbnailEncoder.jpegThumbnail(from: bytes)
    }
    await recorder.recordLatestGeneration(
      mediaID: item.id, title: item.displayTitle, createdAt: item.createdAt, thumbnail: thumbnail)
  }
}
