import Foundation
import os

/// Hand-written wire format for the internal Files routes the web app's generated-media views read:
/// `GET /api/files?filters[generated]=true&filters[type]=...` and `GET /api/files/{id}`.
///
/// Why hand-written: neither route is in the public OpenAPI contract, so the generated client has no
/// operation for them. They are the only way to list generated images (the public video and music list
/// endpoints return generation jobs, not the saved gallery, and there is no image list at all).
/// Keep in sync with `searchFabFilesSchema` (b4m-core/services/src/fabFileService/search.ts).
enum MediaWire {
  private static let logger = Logger(subsystem: "com.bike4mind.app", category: "media")

  /// Logs why a body did not decode (field paths only, no values) before it becomes `malformedResponse`.
  static func decode<T: Decodable>(_ type: T.Type, from body: Data) throws -> T {
    do {
      return try JSONDecoder().decode(type, from: body)
    } catch {
      logger.error(
        "Media response did not decode as \(String(describing: type), privacy: .public): \(WireDecoding.describe(error), privacy: .public)"
      )
      throw APIError.malformedResponse
    }
  }
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
    let sourceMetadata: SourceMetadata?

    private enum CodingKeys: String, CodingKey {
      case id, _id, fileName, mimeType, fileSize, fileUrl, fileUrlExpireAt, createdAt, sourceMetadata
    }

    init(from decoder: any Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)
      id = try container.decodeIfPresent(String.self, forKey: .id)
      _id = try container.decodeIfPresent(String.self, forKey: ._id)
      fileName = try container.decodeIfPresent(String.self, forKey: .fileName)
      mimeType = try container.decodeIfPresent(String.self, forKey: .mimeType)
      fileSize = try container.decodeIfPresent(Int.self, forKey: .fileSize)
      fileUrl = try container.decodeIfPresent(String.self, forKey: .fileUrl)
      fileUrlExpireAt = try container.decodeIfPresent(String.self, forKey: .fileUrlExpireAt)
      createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt)
      sourceMetadata = try? container.decodeIfPresent(SourceMetadata.self, forKey: .sourceMetadata)
    }
  }

  /// Provenance the server stamps on generated files (`sourceMetadata` on the file document). Older files
  /// carry an empty prompt, which reads as unknown.
  /// Decodes field by field and never throws: a provenance shape this build does not expect must not drop
  /// the whole page.
  private struct SourceMetadata: Decodable {
    let sessionId: String?
    let prompt: String?

    private enum Keys: String, CodingKey { case sessionId, generation, prompt }

    init(from decoder: any Decoder) throws {
      let container = try? decoder.container(keyedBy: Keys.self)
      sessionId = try? container?.decodeIfPresent(String.self, forKey: .sessionId)
      let generation = try? container?.nestedContainer(keyedBy: Keys.self, forKey: .generation)
      prompt = try? generation?.decodeIfPresent(String.self, forKey: .prompt)
    }
  }

  static func page(status: Int, body: Data) throws -> MediaPage {
    guard status == 200 else { throw APIError(status: status) }
    let decoded = try decode(ListBody.self, from: body)
    // A row the gallery cannot draw (a document, a malformed record) is skipped, not fatal.
    return MediaPage(items: decoded.data.compactMap(item(from:)), hasMore: decoded.hasMore ?? false)
  }

  static func item(status: Int, body: Data) throws -> MediaItem {
    guard status == 200 else { throw APIError(status: status) }
    guard let item = item(from: try decode(File.self, from: body)) else { throw APIError.malformedResponse }
    return item
  }

  private static func item(from file: File) -> MediaItem? {
    guard let id = file.id ?? file._id, let mimeType = file.mimeType, let kind = MediaKind(mimeType: mimeType) else {
      return nil
    }
    return MediaItem(
      id: id, kind: kind, fileName: file.fileName ?? "", mimeType: mimeType,
      createdAt: file.createdAt.flatMap(parseDate) ?? .distantPast, fileSize: file.fileSize,
      url: file.fileUrl.flatMap(URL.init(string:)), urlExpiresAt: file.fileUrlExpireAt.flatMap(parseDate),
      sessionID: file.sourceMetadata?.sessionId.flatMap { $0.isEmpty ? nil : $0 },
      prompt: file.sourceMetadata?.prompt.flatMap { $0.isEmpty ? nil : $0 })
  }

  static func lineagePath(id: String) throws -> String {
    try detailPath(id: id) + "/lineage"
  }

  /// `GET /api/v1/files/{id}/lineage` (public contract `getFileLineage`). Hand-decoded so an unknown role or
  /// generator never fails the page.
  private struct LineageBody: Decodable {
    let fileID: String
    let ancestors: [Node]
    let children: [Node]
    let edges: [Edge]
    let truncated: Bool?

    private enum CodingKeys: String, CodingKey {
      case fileID = "file_id"
      case ancestors, children, edges, truncated
    }

    struct Node: Decodable {
      let fileID: String
      let redacted: Bool
      let fileName: String?
      let mimeType: String?
      let generator: String?
      let modelID: String?
      let prompt: String?
      let downloadURL: String?
      let createdAt: String?
      let request: JSONObject?

      private enum CodingKeys: String, CodingKey {
        case fileID = "file_id"
        case redacted
        case fileName = "file_name"
        case mimeType = "mime_type"
        case generator
        case modelID = "model_id"
        case prompt
        case downloadURL = "download_url"
        case createdAt = "created_at"
        case request
      }
    }

    struct Edge: Decodable {
      let parentID: String
      let childID: String
      let role: String

      private enum CodingKeys: String, CodingKey {
        case parentID = "parent_id"
        case childID = "child_id"
        case role
      }
    }
  }

  static func lineage(status: Int, body: Data) throws -> FileLineage {
    guard status == 200 else { throw APIError(status: status) }
    let decoded = try decode(LineageBody.self, from: body)
    func node(_ wire: LineageBody.Node) -> LineageNode {
      LineageNode(
        id: wire.fileID, isRedacted: wire.redacted, kind: wire.mimeType.flatMap(MediaKind.init(mimeType:)),
        fileName: wire.fileName ?? "", mimeType: wire.mimeType ?? "", generator: wire.generator,
        modelID: wire.modelID, prompt: wire.prompt.flatMap { $0.isEmpty ? nil : $0 },
        url: wire.downloadURL.flatMap(URL.init(string:)), createdAt: wire.createdAt.flatMap(parseDate),
        request: wire.request)
    }
    let edges = decoded.edges.map {
      LineageEdge(parentID: $0.parentID, childID: $0.childID, role: LineageRole(wire: $0.role))
    }
    return FileLineage(
      fileID: decoded.fileID, ancestors: decoded.ancestors.map(node), children: decoded.children.map(node),
      edges: edges, truncated: decoded.truncated ?? false)
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

  public func lineage(of id: String) async throws -> FileLineage {
    let response = try await requester.send(method: "GET", path: try MediaWire.lineagePath(id: id))
    return try MediaWire.lineage(status: response.status, body: response.body)
  }
}
