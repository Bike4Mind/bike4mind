import Foundation

/// Sends hand-written JSON requests for the few routes the generated client does not cover
/// (`/api/chat`, `/api/websocket/ticket`, `/api/settings/serverConfig`, and the voice routes in `VoiceWire`). Same bearer + single 401 retry
/// policy as `BearerAuthMiddleware`, and failures fold into `APIError` like `APIClient`'s.
struct AuthorizedRequester: Sendable {
  let baseURL: URL
  let tokens: any AccessTokenProviding
  let transport: any HTTPTransport

  struct Response: Sendable {
    let status: Int
    let body: Data
    var contentType: String?
  }

  /// Returns any HTTP response (callers branch on status); throws `APIError` for transport failures and
  /// for a 401 that survives one token refresh. With `codedUnauthorizedIsAnswer`, a 401 whose JSON body carries
  /// an `errorCode` is returned as is: the auth layer's 401s carry none, so it is a route's own answer (tts.ts
  /// reports a provider credential failure that way) and must not refresh tokens or end the session.
  func send(
    method: String, path: String, query: [URLQueryItem] = [], jsonBody: Data? = nil,
    codedUnauthorizedIsAnswer: Bool = false
  ) async throws -> Response {
    func isSessionRejection(_ response: Response) -> Bool {
      response.status == 401 && !(codedUnauthorizedIsAnswer && Self.carriesErrorCode(response.body))
    }
    do {
      let token = try await tokens.accessToken()
      let first = try await perform(method: method, path: path, query: query, body: jsonBody, token: token)
      guard isSessionRejection(first) else { return first }

      await tokens.invalidateAccessToken(token)
      let fresh = try await tokens.accessToken()
      let retry = try await perform(method: method, path: path, query: query, body: jsonBody, token: fresh)
      if isSessionRejection(retry) {
        await tokens.sessionRejected()
        throw APIError.signedOut
      }
      return retry
    } catch let error as APIError {
      throw error
    } catch let error as AuthError {
      throw APIError(error)
    } catch let error as KeychainError where error.isTransient {
      throw APIError(error)
    } catch is URLError {
      throw APIError.offline
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw APIError.malformedResponse
    }
  }

  static func carriesErrorCode(_ body: Data) -> Bool {
    errorCode(in: body) != nil
  }

  static func errorCode(in body: Data) -> String? {
    (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["errorCode"] as? String
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
    return Response(
      status: response.statusCode, body: data, contentType: response.value(forHTTPHeaderField: "Content-Type"))
  }
}
