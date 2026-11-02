import Foundation
import HTTPTypes
import OpenAPIRuntime

/// Adds `Authorization: Bearer` to every request and answers a 401 exactly once: drop the token,
/// fetch a fresh one, resend. A second 401 means the session is dead.
struct BearerAuthMiddleware: ClientMiddleware {
  let tokens: any AccessTokenProviding

  func intercept(
    _ request: HTTPRequest,
    body: HTTPBody?,
    baseURL: URL,
    operationID: String,
    next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
  ) async throws -> (HTTPResponse, HTTPBody?) {
    let token = try await tokens.accessToken()
    let (response, responseBody) = try await next(authorized(request, token: token), body, baseURL)
    guard response.status == .unauthorized else { return (response, responseBody) }

    // A one-shot body cannot be resent; surface the 401 rather than send a truncated request.
    guard body == nil || body?.iterationBehavior == .multiple else { return (response, responseBody) }

    await tokens.invalidateAccessToken()
    let freshToken = try await tokens.accessToken()
    let (retryResponse, retryBody) = try await next(authorized(request, token: freshToken), body, baseURL)
    if retryResponse.status == .unauthorized {
      await tokens.sessionRejected()
    }
    return (retryResponse, retryBody)
  }

  private func authorized(_ request: HTTPRequest, token: String) -> HTTPRequest {
    var request = request
    request.headerFields[.authorization] = "Bearer \(token)"
    return request
  }
}
