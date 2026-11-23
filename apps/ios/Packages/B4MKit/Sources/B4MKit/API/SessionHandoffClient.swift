import Foundation

public struct HandoffDevice: Decodable, Identifiable, Sendable, Equatable {
  public let id: String
  public let name: String
  public let platform: String
  public let available: Bool
}

public struct SessionHandoffClient: Sendable {
  private let requester: AuthorizedRequester

  public init(baseURL: URL, tokens: any AccessTokenProviding, transport: any HTTPTransport = URLSessionTransport()) {
    requester = AuthorizedRequester(baseURL: baseURL, tokens: tokens, transport: transport)
  }

  public func devices() async throws -> [HandoffDevice] {
    let response = try await requester.send(method: "GET", path: "api/v1/handoff-devices")
    guard response.status == 200 else { throw APIError(status: response.status) }
    struct Devices: Decodable { let devices: [HandoffDevice] }
    return try JSONDecoder().decode(Devices.self, from: response.body).devices
  }

  public func send(sessionID: String, deviceID: String) async throws {
    struct Body: Encodable { let sessionId: String; let deviceId: String }
    let response = try await requester.send(
      method: "POST", path: "api/v1/session-handoffs",
      jsonBody: JSONEncoder().encode(Body(sessionId: sessionID, deviceId: deviceID)))
    guard response.status == 200 else { throw APIError(status: response.status) }
  }
}
