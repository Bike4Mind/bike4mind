import Foundation

public protocol BriefAPI: Sendable {
  /// Starts composing a brief. Idempotent on the server while one is already composing.
  func compose() async throws -> Brief
  /// The user's briefs, newest first.
  func list() async throws -> [Brief]
  func brief(id: String) async throws -> Brief
}

/// Hand-written client for `/api/v1/briefs` (JWT bearer). The push that announces a brief carries only its
/// id: the content is always fetched here, with the user's own credentials.
public struct BriefClient: BriefAPI {
  private let requester: AuthorizedRequester

  public init(baseURL: URL, tokens: any AccessTokenProviding, transport: any HTTPTransport = URLSessionTransport()) {
    requester = AuthorizedRequester(baseURL: baseURL, tokens: tokens, transport: transport)
  }

  private struct ListResponse: Decodable {
    let briefs: [Brief]
  }

  public func compose() async throws -> Brief {
    try await decode(Brief.self, method: "POST", path: "api/v1/briefs")
  }

  public func list() async throws -> [Brief] {
    try await decode(ListResponse.self, method: "GET", path: "api/v1/briefs").briefs
  }

  public func brief(id: String) async throws -> Brief {
    guard DeepLinkRouter.isValidIdentifier(id) else { throw APIError.notFound }
    return try await decode(Brief.self, method: "GET", path: "api/v1/briefs/\(id)")
  }

  private func decode<Body: Decodable>(_ type: Body.Type, method: String, path: String) async throws -> Body {
    let response = try await requester.send(method: method, path: path)
    guard (200..<300).contains(response.status) else { throw APIError(status: response.status) }
    do {
      return try Self.decoder.decode(type, from: response.body)
    } catch {
      throw APIError.malformedResponse
    }
  }

  /// The server writes JS dates with milliseconds; tolerate their absence too.
  private static let decoder: JSONDecoder = {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let raw = try decoder.singleValueContainer().decode(String.self)
      if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(raw) { return date }
      if let date = try? Date.ISO8601FormatStyle().parse(raw) { return date }
      throw DecodingError.dataCorrupted(
        .init(codingPath: decoder.codingPath, debugDescription: "Not an ISO 8601 date"))
    }
    return decoder
  }()
}
