import Foundation

/// Hand-written wire format for the internal Files routes the web app's generated-media views read:
/// `GET /api/files?filters[generated]=true&filters[type]=...` and `GET /api/files/{id}`.
///
/// Why hand-written: neither route is in the public OpenAPI contract, so the generated client has no
/// operation for them. They are the only way to list generated images (the public video and music list
/// endpoints return generation jobs, not the saved gallery, and there is no image list at all).
/// Keep in sync with `searchFabFilesSchema` (b4m-core/services/src/fabFileService/search.ts).
enum MediaWire {
  static let filesPath = "api/files"

  static func listQuery(kind: MediaKind?, page: Int, limit: Int) -> [URLQueryItem] {
    var query = [URLQueryItem(name: "filters[generated]", value: "true")]
    if let kind { query.append(URLQueryItem(name: "filters[type]", value: kind.rawValue)) }
    query += [
      URLQueryItem(name: "pagination[page]", value: String(page)),
      URLQueryItem(name: "pagination[limit]", value: String(limit)),
      URLQueryItem(name: "order[by]", value: "createdAt"),
      URLQueryItem(name: "order[direction]", value: "desc"),
      // The gallery never needs extracted text, which can be megabytes per file.
      URLQueryItem(name: "options[excludeContent]", value: "true"),
    ]
    return query
  }

  static func detailPath(id: String) throws -> String {
    guard !id.isEmpty, id.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else {
      throw APIError.notFound
    }
    return "\(filesPath)/\(id)"
  }

  private struct ListBody: Decodable {
    let data: [File]
    let hasMore: Bool?
  }

  private struct File: Decodable {
    let id: String?
    let _id: String?
    let fileName: String?
    let mimeType: String?
    let fileSize: Int?
    let fileUrl: String?
    let fileUrlExpireAt: String?
    let createdAt: String?
  }

  static func page(status: Int, body: Data) throws -> MediaPage {
    guard status == 200 else { throw APIError(status: status) }
    guard let decoded = try? JSONDecoder().decode(ListBody.self, from: body) else {
      throw APIError.malformedResponse
    }
    // A row the gallery cannot draw (a document, a malformed record) is skipped, not fatal.
    return MediaPage(items: decoded.data.compactMap(item(from:)), hasMore: decoded.hasMore ?? false)
  }

  static func item(status: Int, body: Data) throws -> MediaItem {
    guard status == 200 else { throw APIError(status: status) }
    guard let file = try? JSONDecoder().decode(File.self, from: body), let item = item(from: file) else {
      throw APIError.malformedResponse
    }
    return item
  }

  private static func item(from file: File) -> MediaItem? {
    guard let id = file.id ?? file._id, let mimeType = file.mimeType, let kind = MediaKind(mimeType: mimeType) else {
      return nil
    }
    return MediaItem(
      id: id, kind: kind, fileName: file.fileName ?? "", mimeType: mimeType,
      createdAt: file.createdAt.flatMap(parseDate) ?? .distantPast, fileSize: file.fileSize,
      url: file.fileUrl.flatMap(URL.init(string:)), urlExpiresAt: file.fileUrlExpireAt.flatMap(parseDate))
  }

  private static func parseDate(_ string: String) -> Date? {
    if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(string) { return date }
    return try? Date.ISO8601FormatStyle().parse(string)
  }
}

/// `MediaAPI` over `AuthorizedRequester`: bearer, one 401 retry, failures folded into `APIError`.
public struct MediaClient: MediaAPI {
  private let requester: AuthorizedRequester

  public init(baseURL: URL, tokens: any AccessTokenProviding, transport: any HTTPTransport = URLSessionTransport()) {
    requester = AuthorizedRequester(baseURL: baseURL, tokens: tokens, transport: transport)
  }

  public func listMedia(kind: MediaKind?, page: Int, limit: Int) async throws -> MediaPage {
    let response = try await requester.send(
      method: "GET", path: MediaWire.filesPath, query: MediaWire.listQuery(kind: kind, page: page, limit: limit))
    return try MediaWire.page(status: response.status, body: response.body)
  }

  public func media(id: String) async throws -> MediaItem {
    let response = try await requester.send(method: "GET", path: try MediaWire.detailPath(id: id))
    return try MediaWire.item(status: response.status, body: response.body)
  }
}
