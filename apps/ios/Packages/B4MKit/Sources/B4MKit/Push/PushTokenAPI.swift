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
  /// Registers the push token of one Live Activity, which the server uses to push that quest's progress.
  /// Must happen as soon as the activity has a token: frames sent before registration are dropped.
  func registerLiveActivityToken(
    _ token: String, activityID: String, questID: String, environment: PushEnvironment, appVersion: String?
  ) async throws
  func unregisterPushToken(_ token: String) async throws
}

/// Hand-written client for `registerPushToken` / `unregisterPushToken`.
///
/// These operations are not in the generated client's spec snapshot yet; they move into
/// `B4MClient` (and behind `B4MAPI`) when the snapshot next updates. Until then this keeps the same
/// bearer + single-401-retry behavior as `APIClient`.
public struct PushTokenClient: PushTokenAPI {
  private let requester: AuthorizedRequester

  public init(baseURL: URL, tokens: any AccessTokenProviding, transport: any HTTPTransport = URLSessionTransport()) {
    requester = AuthorizedRequester(baseURL: baseURL, tokens: tokens, transport: transport)
  }

  /// `POST /api/v1/push-tokens`. `activityId` and `questId` are set only for `kind: liveActivity`; nil
  /// fields are omitted from the JSON.
  private struct RegisterBody: Encodable {
    let token: String
    let kind: String
    let platform = "ios"
    let environment: PushEnvironment
    let activityId: String?
    let questId: String?
    let appVersion: String?
  }

  private struct UnregisterBody: Encodable {
    let token: String
  }

  public func registerPushToken(_ token: String, environment: PushEnvironment, appVersion: String?) async throws {
    let body = try JSONEncoder().encode(
      RegisterBody(
        token: token, kind: "device", environment: environment, activityId: nil, questId: nil, appVersion: appVersion))
    try await send(method: "POST", body: body)
  }

  public func registerLiveActivityToken(
    _ token: String, activityID: String, questID: String, environment: PushEnvironment, appVersion: String?
  ) async throws {
    let body = try JSONEncoder().encode(
      RegisterBody(
        token: token, kind: "liveActivity", environment: environment, activityId: activityID, questId: questID,
        appVersion: appVersion))
    try await send(method: "POST", body: body)
  }

  public func unregisterPushToken(_ token: String) async throws {
    try await send(method: "DELETE", body: try JSONEncoder().encode(UnregisterBody(token: token)))
  }

  /// Same bearer, single-401-retry and error folding as every other hand-written route.
  private func send(method: String, body: Data) async throws {
    let response = try await requester.send(method: method, path: "api/v1/push-tokens", jsonBody: body)
    guard (200..<300).contains(response.status) else { throw APIError(status: response.status) }
  }
}
