import Foundation

/// Hand-written client for the un-contracted auth routes (`/api/oauth/*`, `/api/auth/*`, `/api/logout`).
/// Those routes are not API-key surface, so they stay out of the generated OpenAPI client.
struct AuthAPI: Sendable {
  struct TokenGrant: Sendable, Equatable {
    let accessToken: String
    let refreshToken: String
  }

  struct RefreshResult: Sendable, Equatable {
    let accessToken: String
    /// Absent when the server coalesced a replay inside its grace window: keep the current token.
    let refreshToken: String?
  }

  let baseURL: URL
  let transport: any HTTPTransport

  /// `POST /api/oauth/token` (snake_case, RFC 6749 shape).
  func exchangeCode(
    _ code: String,
    verifier: String,
    configuration: OAuthConfiguration,
    deviceName: String?
  ) async throws -> TokenGrant {
    struct Body: Encodable {
      let grantType = "authorization_code"
      let code: String
      let codeVerifier: String
      let clientID: String
      let redirectURI: String
      let deviceName: String?

      enum CodingKeys: String, CodingKey {
        case grantType = "grant_type"
        case code
        case codeVerifier = "code_verifier"
        case clientID = "client_id"
        case redirectURI = "redirect_uri"
        case deviceName
      }
    }
    struct Response: Decodable {
      let accessToken: String
      let refreshToken: String

      enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
      }
    }
    struct ErrorResponse: Decodable {
      let error: String?
    }

    let body = Body(
      code: code,
      codeVerifier: verifier,
      clientID: configuration.clientID,
      redirectURI: configuration.redirectURI.absoluteString,
      deviceName: deviceName
    )
    let (data, response) = try await transport.send(jsonRequest("api/oauth/token", body: body))
    guard response.statusCode == 200 else {
      let code = (try? JSONDecoder().decode(ErrorResponse.self, from: data))?.error
      throw AuthError.tokenExchangeFailed(status: response.statusCode, code: code)
    }
    guard let grant = try? JSONDecoder().decode(Response.self, from: data) else {
      throw AuthError.invalidResponse
    }
    return TokenGrant(accessToken: grant.accessToken, refreshToken: grant.refreshToken)
  }

  /// `POST /api/auth/refreshToken` with body transport (camelCase legacy route).
  func refresh(refreshToken: String) async throws -> RefreshResult {
    struct Body: Encodable {
      let token: String
    }
    struct Response: Decodable {
      let accessToken: String
      let refreshToken: String?
    }

    let (data, response) = try await transport.send(
      jsonRequest("api/auth/refreshToken", body: Body(token: refreshToken)))
    switch response.statusCode {
    case 200:
      guard let result = try? JSONDecoder().decode(Response.self, from: data) else {
        throw AuthError.invalidResponse
      }
      return RefreshResult(accessToken: result.accessToken, refreshToken: result.refreshToken)
    case 401:
      throw AuthError.refreshRejected
    case 429:
      throw AuthError.rateLimited
    default:
      throw AuthError.server(status: response.statusCode)
    }
  }

  /// `GET /api/logout` revokes the AuthSession named by the bearer token's `sid`.
  func logout(accessToken: String) async throws {
    var request = URLRequest(url: baseURL.appending(path: "api/logout"))
    request.httpMethod = "GET"
    request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    let (_, response) = try await transport.send(request)
    guard (200..<300).contains(response.statusCode) else {
      throw AuthError.server(status: response.statusCode)
    }
  }

  private func jsonRequest(_ path: String, body: some Encodable) throws -> URLRequest {
    var request = URLRequest(url: baseURL.appending(path: path))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.httpBody = try JSONEncoder().encode(body)
    return request
  }
}
