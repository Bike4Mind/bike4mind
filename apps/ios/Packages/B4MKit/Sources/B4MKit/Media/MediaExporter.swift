import Foundation

/// Why a file could not be prepared for sharing or saving.
public enum MediaExportError: Error, Equatable, Sendable {
  /// The file has no downloadable URL yet (still being scanned or processed).
  case notAvailable
  case api(APIError)
}

/// Where an exported file can go. Photos holds images and video only; audio goes to Files or the share sheet.
public enum MediaDestination: Equatable, Sendable {
  case share
  case photos
  case files

  /// Whether the Photos library can hold this kind of media.
  public static func canSaveToPhotos(_ kind: MediaKind) -> Bool { kind != .audio }
}

/// Downloads a gallery item's bytes to a local file, so the share sheet and Photos receive the media itself
/// rather than a signed link that expires. The download is injected: the app owns the URLSession.
public struct MediaExporter: Sendable {
  public typealias Download = @Sendable (URL) async throws -> URL

  private let api: any MediaAPI
  private let download: Download
  private let directory: URL
  private let now: @Sendable () -> Date

  public init(
    api: any MediaAPI, download: @escaping Download,
    directory: URL = FileManager.default.temporaryDirectory.appending(
      path: "MediaExports", directoryHint: .isDirectory),
    now: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.api = api
    self.download = download
    self.directory = directory
    self.now = now
  }

  /// A local copy named after the item. A lapsed signed URL is refetched first.
  public func export(_ item: MediaItem) async throws -> URL {
    do {
      let fresh = item.isURLUsable(at: now()) ? item : try await api.media(id: item.id)
      guard let url = fresh.url else { throw MediaExportError.notAvailable }
      let downloaded = try await download(url)
      return try place(downloaded, as: Self.fileName(for: fresh))
    } catch let error as MediaExportError {
      throw error
    } catch let error as APIError {
      throw MediaExportError.api(error)
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw MediaExportError.api(.offline)
    }
  }

  private func place(_ downloaded: URL, as name: String) throws -> URL {
    let folder = directory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let target = folder.appending(path: name)
    try FileManager.default.moveItem(at: downloaded, to: target)
    return target
  }

  /// The stored name when it has an extension, else one derived from the MIME type; path separators are dropped.
  static func fileName(for item: MediaItem) -> String {
    let cleaned = item.fileName.replacingOccurrences(of: "/", with: "-").trimmingCharacters(in: .whitespaces)
    let base = cleaned.isEmpty ? item.kind.rawValue : cleaned
    guard (base as NSString).pathExtension.isEmpty else { return base }
    return base + "." + fileExtension(forMIMEType: item.mimeType, kind: item.kind)
  }

  static func fileExtension(forMIMEType mimeType: String, kind: MediaKind) -> String {
    switch mimeType.lowercased() {
    case "image/png": "png"
    case "image/jpeg", "image/jpg": "jpg"
    case "image/webp": "webp"
    case "image/heic": "heic"
    case "video/mp4": "mp4"
    case "video/quicktime": "mov"
    case "audio/mpeg", "audio/mp3": "mp3"
    case "audio/wav", "audio/x-wav": "wav"
    case "audio/mp4", "audio/m4a": "m4a"
    default:
      switch kind {
      case .image: "png"
      case .video: "mp4"
      case .audio: "mp3"
      }
    }
  }
}
