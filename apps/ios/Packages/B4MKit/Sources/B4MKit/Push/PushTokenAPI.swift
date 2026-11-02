import Foundation

/// APNs environment the token belongs to. Debug builds are signed with the development
/// entitlement, so their tokens only work against the sandbox gateway.
public enum PushEnvironment: String, Sendable, Codable {
  case sandbox
  case production

  public static var forThisBuild: PushEnvironment {
    #if DEBUG
      .sandbox
    #else
      .production
    #endif
  }
}

public protocol PushTokenAPI: Sendable {
  /// Idempotent upsert of this device's APNs token for the signed-in user.
  func registerPushToken(_ token: String, environment: PushEnvironment, appVersion: String?) async throws
  func unregisterPushToken(_ token: String) async throws
}

/// Hand-written client for `registerPushToken` / `unregisterPushToken`.
///
/// These operations are not in the generated client's spec snapshot yet; they move into
/// `B4MClient` (and behind `B4MAPI`) when the snapshot next updates. Until then this keeps the same
/// bearer + single-401-retry behavior as `APIClient`.
public struct PushTokenClient: PushTokenAPI {
  private let baseURL: URL
  private let tokens: any AccessTokenProviding
  private let transport: any HTTPTransport

  public init(baseURL: URL, tokens: any AccessTokenProviding, transport: any HTTPTransport = URLSessionTransport()) {
    self.baseURL = baseURL
    self.tokens = tokens
    self.transport = transport
  }

  private struct RegisterBody: Encodable {
    let token: String
    let kind = "device"
    let platform = "ios"
    let environment: PushEnvironment
    let appVersion: String?
  }

  private struct UnregisterBody: Encodable {
    let token: String
  }

  public func registerPushToken(_ token: String, environment: PushEnvironment, appVersion: String?) async throws {
    let body = try JSONEncoder().encode(RegisterBody(token: token, environment: environment, appVersion: appVersion))
    try await send(method: "POST", body: body)
  }

  public func unregisterPushToken(_ token: String) async throws {
    try await send(method: "DELETE", body: try JSONEncoder().encode(UnregisterBody(token: token)))
  }

  private func send(method: String, body: Data) async throws {
    var attempt = 0
    while true {
      var request = URLRequest(url: baseURL.appending(path: "api/v1/push-tokens"))
      request.httpMethod = method
      request.httpBody = body
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.setValue("Bearer \(try await tokens.accessToken())", forHTTPHeaderField: "Authorization")

      let response: HTTPURLResponse
      do {
        response = try await transport.send(request).1
      } catch is URLError {
        throw APIError.offline
      }
      switch response.statusCode {
      case 200..<300:
        return
      case 401 where attempt == 0:
        attempt += 1
        await tokens.invalidateAccessToken()
      case 401:
        await tokens.sessionRejected()
        throw APIError.signedOut
      case let status:
        throw APIError(status: status)
      }
    }
  }
}
