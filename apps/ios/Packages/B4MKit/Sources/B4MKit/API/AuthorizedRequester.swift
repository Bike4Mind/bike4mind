import Foundation

/// Sends hand-written JSON requests for the few routes the generated client does not cover
/// (`/api/chat`, `/api/websocket/ticket`, `/api/settings/serverConfig`). Same bearer + single 401 retry
/// policy as `BearerAuthMiddleware`, and failures fold into `APIError` like `APIClient`'s.
struct AuthorizedRequester: Sendable {
  let baseURL: URL
  let tokens: any AccessTokenProviding
  let transport: any HTTPTransport

  struct Response: Sendable {
    let status: Int
    let body: Data
  }

  /// Returns any HTTP response (callers branch on status); throws `APIError` for transport failures and
  /// for a 401 that survives one token refresh.
  func send(
    method: String, path: String, query: [URLQueryItem] = [], jsonBody: Data? = nil
  ) async throws -> Response {
    do {
      let token = try await tokens.accessToken()
      let first = try await perform(method: method, path: path, query: query, body: jsonBody, token: token)
      guard first.status == 401 else { return first }

      await tokens.invalidateAccessToken()
      let fresh = try await tokens.accessToken()
      let retry = try await perform(method: method, path: path, query: query, body: jsonBody, token: fresh)
      if retry.status == 401 {
        await tokens.sessionRejected()
        throw APIError.signedOut
      }
      return retry
    } catch let error as APIError {
      throw error
    } catch is AuthError {
      throw APIError.signedOut
    } catch is URLError {
      throw APIError.offline
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw APIError.malformedResponse
    }
  }

  private func perform(
    method: String, path: String, query: [URLQueryItem], body: Data?, token: String
  ) async throws -> Response {
    var url = baseURL.appending(path: path)
    if !query.isEmpty { url.append(queryItems: query) }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = body
    }
    let (data, response) = try await transport.send(request)
    return Response(status: response.statusCode, body: data)
  }
}
