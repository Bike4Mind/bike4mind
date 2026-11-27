import Foundation

/// A local file staged for upload, already copied out of the share provider's short-lived temp location.
public struct SharedFile: Hashable, Sendable, Codable {
  public let fileURL: URL
  public let fileName: String
  public let mimeType: String
  public let byteCount: Int

  public init(fileURL: URL, fileName: String, mimeType: String, byteCount: Int) {
    self.fileURL = fileURL
    self.fileName = fileName
    self.mimeType = mimeType
    self.byteCount = byteCount
  }
}

/// One thing the user shared, typed by what it is rather than by the UTI it arrived as.
public enum ShareItem: Hashable, Sendable {
  case url(URL)
  case text(String)
  case image(SharedFile)
  case pdf(SharedFile)
  case file(SharedFile)

  /// The staged file for the cases that carry one.
  public var file: SharedFile? {
    switch self {
    case .image(let file), .pdf(let file), .file(let file): file
    case .url, .text: nil
    }
  }

  /// Short label for the composer ("Image", "Link", ...).
  public var kindLabel: String {
    switch self {
    case .url: "Link"
    case .text: "Text"
    case .image: "Image"
    case .pdf: "PDF"
    case .file: "File"
    }
  }

  public var displayName: String {
    switch self {
    case .url(let url): url.absoluteString
    case .text(let text): String(text.prefix(80))
    case .image(let file), .pdf(let file), .file(let file): file.fileName
    }
  }
}
