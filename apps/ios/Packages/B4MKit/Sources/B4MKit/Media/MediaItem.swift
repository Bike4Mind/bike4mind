import Foundation

public enum MediaKind: String, CaseIterable, Hashable, Sendable {
  case image, video, audio

  /// `nil` for anything the gallery cannot show (documents).
  init?(mimeType: String) {
    let prefix = mimeType.lowercased().split(separator: "/").first.map(String.init)
    guard let prefix, let kind = MediaKind(rawValue: prefix) else { return nil }
    self = kind
  }

  public var title: String {
    switch self {
    case .image: "Images"
    case .video: "Video"
    case .audio: "Audio"
    }
  }
}

/// One generated file as the gallery shows it.
public struct MediaItem: Identifiable, Hashable, Sendable {
  public let id: String
  public let kind: MediaKind
  public let fileName: String
  public let mimeType: String
  public let createdAt: Date
  public let fileSize: Int?
  /// A presigned storage URL. Short-lived: see `isURLUsable(at:)`.
  public let url: URL?
  public let urlExpiresAt: Date?
  /// The notebook a generated file came from; an image edit must run in a session, so it reuses this one.
  public let sessionID: String?
  /// The prompt that made it, when the server recorded one.
  public let prompt: String?

  public init(
    id: String, kind: MediaKind, fileName: String, mimeType: String, createdAt: Date, fileSize: Int? = nil,
    url: URL? = nil, urlExpiresAt: Date? = nil, sessionID: String? = nil, prompt: String? = nil
  ) {
    self.id = id
    self.kind = kind
    self.fileName = fileName
    self.mimeType = mimeType
    self.createdAt = createdAt
    self.fileSize = fileSize
    self.url = url
    self.urlExpiresAt = urlExpiresAt
    self.sessionID = sessionID
    self.prompt = prompt
  }

  /// Presigned URLs are refetched this long before they lapse, so a player never starts on a URL that
  /// dies a second later.
  public static let expiryMargin: TimeInterval = 60

  /// Whether `url` can be handed to a loader now. A URL with no known expiry is trusted until it fails.
  public func isURLUsable(at date: Date) -> Bool {
    guard url != nil else { return false }
    guard let urlExpiresAt else { return true }
    return urlExpiresAt.timeIntervalSince(date) > Self.expiryMargin
  }

  public var displayTitle: String {
    let name = (fileName as NSString).deletingPathExtension
    return name.isEmpty ? kind.title : name
  }
}

public struct MediaPage: Equatable, Sendable {
  public let items: [MediaItem]
  public let hasMore: Bool

  public init(items: [MediaItem], hasMore: Bool) {
    self.items = items
    self.hasMore = hasMore
  }
}

/// What the gallery asks of the backend. Hand-written wire client behind it (`MediaClient`).
public protocol MediaAPI: Sendable {
  /// Generated media, newest first. `page` is 1-based.
  func listMedia(kind: MediaKind?, page: Int, limit: Int) async throws -> MediaPage
  /// One item with a freshly signed URL.
  func media(id: String) async throws -> MediaItem
}
