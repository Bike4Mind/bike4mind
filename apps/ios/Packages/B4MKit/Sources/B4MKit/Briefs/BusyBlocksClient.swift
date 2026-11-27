import Foundation

public protocol BusyBlocksAPI: Sendable {
  func state() async throws -> BusyBlocksState
  /// Replaces the stored blocks; `enabled: false` also clears them on the server.
  func save(enabled: Bool, blocks: [BusyBlock]) async throws -> BusyBlocksState
}

/// Hand-written client for `GET`/`PUT /api/v1/briefs/busy-blocks` until the generated client's spec snapshot
/// includes them.
public struct BusyBlocksClient: BusyBlocksAPI {
  private let requester: AuthorizedRequester
  private static let path = "api/v1/briefs/busy-blocks"

  public init(baseURL: URL, tokens: any AccessTokenProviding, transport: any HTTPTransport = URLSessionTransport()) {
    requester = AuthorizedRequester(baseURL: baseURL, tokens: tokens, transport: transport)
  }

  /// Captures the server and credential owner once for an admitted operation.
  @MainActor
  public static func session(
    for auth: AuthController, transport: any HTTPTransport = URLSessionTransport()
  ) -> BusyBlockSession {
    let ticket = auth.captureSession()
    let client = BusyBlocksClient(
      baseURL: ticket.environment.baseURL, tokens: auth.scopedTokens(for: ticket), transport: transport)
    return BusyBlockSession(id: ticket.id, api: client, isCurrent: { auth.isCurrent(ticket) })
  }

  public func state() async throws -> BusyBlocksState {
    try decode(try await requester.send(method: "GET", path: Self.path))
  }

  public func save(enabled: Bool, blocks: [BusyBlock]) async throws -> BusyBlocksState {
    let body = try Self.encoder.encode(PutBody(enabled: enabled, blocks: blocks))
    return try decode(try await requester.send(method: "PUT", path: Self.path, jsonBody: body))
  }

  private struct PutBody: Encodable {
    let enabled: Bool
    let blocks: [BusyBlock]
  }

  private static var encoder: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .custom { date, encoder in
      var container = encoder.singleValueContainer()
      try container.encode(BusyBlockDates.string(from: date))
    }
    return encoder
  }

  private static var decoder: JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let container = try decoder.singleValueContainer()
      let raw = try container.decode(String.self)
      guard let date = BusyBlockDates.date(from: raw) else {
        throw DecodingError.dataCorruptedError(in: container, debugDescription: "Not an ISO 8601 date: \(raw)")
      }
      return date
    }
    return decoder
  }

  private func decode(_ response: AuthorizedRequester.Response) throws -> BusyBlocksState {
    guard (200..<300).contains(response.status) else { throw APIError(status: response.status) }
    do {
      return try Self.decoder.decode(BusyBlocksState.self, from: response.body)
    } catch {
      throw APIError.malformedResponse
    }
  }
}
