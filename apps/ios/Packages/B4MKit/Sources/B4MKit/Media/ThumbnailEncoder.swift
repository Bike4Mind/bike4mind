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
  /// A hard ceiling so a surprise 200 MB file cannot be pulled into memory just for a widget. Enforced while
  /// streaming: a declared oversize body is refused before any of it is read, and an undeclared one is cut
  /// off as soon as it passes the cap.
  public static let maxBytes = 20 * 1024 * 1024

  private let session: URLSession

  public init(session: URLSession = .shared) {
    self.session = session
  }

  public func download(_ url: URL) async throws -> Data {
    let (bytes, response) = try await session.bytes(from: url)
    // expectedContentLength is -1 when the server did not say; the loop below still enforces the cap.
    guard (response as? HTTPURLResponse)?.statusCode == 200, response.expectedContentLength <= Int64(Self.maxBytes)
    else {
      bytes.task.cancel()
      throw URLError(.badServerResponse)
    }
    var data = Data()
    if response.expectedContentLength > 0 { data.reserveCapacity(Int(response.expectedContentLength)) }
    for try await byte in bytes {
      data.append(byte)
      if data.count > Self.maxBytes {
        bytes.task.cancel()
        throw URLError(.dataLengthExceedsMaximum)
      }
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
