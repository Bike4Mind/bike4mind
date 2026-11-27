import Foundation

/// How `WSClient` learns where to connect and obtains a connection credential. A protocol so the
/// socket tests never involve HTTP.
public protocol RealtimeHandshaking: Sendable {
  /// The deployment's WebSocket endpoint (`wss://...`).
  func websocketURL() async throws -> URL
  /// A single-use connection ticket, valid for 30 seconds. Never reuse one across connects.
  func mintTicket() async throws -> String
}

/// The production handshake over the hand-written authenticated routes. Neither route is in the
/// public OpenAPI contract: both are JWT-only first-party surface.
public struct RealtimeHandshake: RealtimeHandshaking {
  private let requester: AuthorizedRequester

  public init(baseURL: URL, tokens: any AccessTokenProviding, transport: any HTTPTransport = URLSessionTransport()) {
    requester = AuthorizedRequester(baseURL: baseURL, tokens: tokens, transport: transport)
  }

  /// `GET /api/settings/serverConfig` (authenticated; the public variant omits the WS URL).
  public func websocketURL() async throws -> URL {
    struct Config: Decodable {
      let websocketUrl: String?
    }
    let response = try await requester.send(method: "GET", path: "api/settings/serverConfig")
    guard response.status == 200 else { throw APIError(status: response.status) }
    guard let raw = try? JSONDecoder().decode(Config.self, from: response.body).websocketUrl,
      let url = URL(string: raw), url.scheme == "wss" || url.scheme == "ws"
    else { throw APIError.malformedResponse }
    return url
  }

  /// `POST /api/websocket/ticket`, answered 201 `{ticket}`.
  public func mintTicket() async throws -> String {
    struct Ticket: Decodable {
      let ticket: String
    }
    let response = try await requester.send(method: "POST", path: "api/websocket/ticket")
    guard response.status == 200 || response.status == 201 else { throw APIError(status: response.status) }
    guard let ticket = try? JSONDecoder().decode(Ticket.self, from: response.body).ticket, !ticket.isEmpty else {
      throw APIError.malformedResponse
    }
    return ticket
  }
}

extension URL {
  /// The connect URL for one ticket: `?ticket=` appended to whatever query the endpoint already has.
  func appendingTicket(_ ticket: String) -> URL {
    appending(queryItems: [URLQueryItem(name: "ticket", value: ticket)])
  }
}
