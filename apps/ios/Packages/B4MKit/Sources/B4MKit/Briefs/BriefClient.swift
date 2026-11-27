import Foundation

public protocol BriefAPI: Sendable {
  /// Starts composing a brief. Idempotent on the server while one is already composing.
  func compose() async throws -> Brief
  /// The user's briefs, newest first.
  func list() async throws -> [Brief]
  func brief(id: String) async throws -> Brief
  /// Replies to a question decision. `choiceIndex` names the suggested option the text came from, if any.
  /// - Throws: `BriefReplyFailure`.
  func reply(briefID: String, decisionID: String, text: String, choiceIndex: Int?) async throws -> BriefReplyResult
}

/// The agent run a reply started.
public struct BriefReplyResult: Equatable, Sendable, Decodable {
  public let executionID: String
  public let sessionID: String

  public init(executionID: String, sessionID: String) {
    self.executionID = executionID
    self.sessionID = sessionID
  }

  private enum CodingKeys: String, CodingKey {
    case executionID = "executionId"
    case sessionID = "sessionId"
  }
}

/// Why a reply did not go through. `.closed` is final: the question was answered or the conversation moved on.
public enum BriefReplyFailure: Error, Equatable, Sendable {
  case closed
  case notFound
  case invalid
  /// The server refused this attempt but the question is still open (agents busy, billing to re-check).
  case refused(String)
  /// Dispatch was rejected or its acceptance is unknown. Preserve the server's check-first guidance.
  case dispatchFailed(String)
  case api(APIError)

  public var message: String {
    switch self {
    case .closed: "This question was already answered."
    case .notFound: "This question is no longer available."
    case .invalid: "Write a reply before sending."
    case .refused(let reason): reason
    case .dispatchFailed(let reason): reason
    case .api(.offline): "You appear to be offline. Check your connection and try again."
    case .api(.rateLimited): "Too many requests. Wait a moment and try again."
    case .api(.signedOut): "Your session ended. Sign in to Bike4Mind and try again."
    case .api: "Bike4Mind had a problem sending your reply. Try again in a moment."
    }
  }
}

/// Hand-written client for `/api/v1/briefs` (JWT bearer). The push that announces a brief carries only its
/// id: the content is always fetched here, with the user's own credentials.
public struct BriefClient: BriefAPI {
  let requester: AuthorizedRequester

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

  public func reply(
    briefID: String, decisionID: String, text: String, choiceIndex: Int?
  ) async throws -> BriefReplyResult {
    guard DeepLinkRouter.isValidIdentifier(briefID), DeepLinkRouter.isValidIdentifier(decisionID) else {
      throw BriefReplyFailure.notFound
    }
    let body = try JSONEncoder().encode(ReplyBody(text: text, choiceIndex: choiceIndex))
    let response: AuthorizedRequester.Response
    do {
      response = try await requester.send(
        method: "POST", path: "api/v1/briefs/\(briefID)/decisions/\(decisionID)/reply", jsonBody: body)
    } catch let error as APIError {
      throw BriefReplyFailure.api(error)
    }
    switch response.status {
    case 200..<300:
      guard let result = try? Self.decoder.decode(BriefReplyResult.self, from: response.body) else {
        throw BriefReplyFailure.api(.malformedResponse)
      }
      return result
    case 404: throw BriefReplyFailure.notFound
    case 409 where Self.errorEnvelope(response.body)?.errorCode == Self.questionClosedErrorCode:
      throw BriefReplyFailure.closed
    case 400, 403, 409:
      let reason = Self.errorEnvelope(response.body)?.error?.trimmingCharacters(in: .whitespacesAndNewlines)
      throw BriefReplyFailure.refused(reason.flatMap { $0.isEmpty ? nil : $0 } ?? Self.fallbackRefusal)
    case 502:
      let reason = Self.errorEnvelope(response.body)?.error?.trimmingCharacters(in: .whitespacesAndNewlines)
      throw BriefReplyFailure.dispatchFailed(reason.flatMap { $0.isEmpty ? nil : $0 } ?? Self.fallbackDispatchFailure)
    default: throw BriefReplyFailure.api(APIError(status: response.status))
    }
  }

  // Must match BRIEF_QUESTION_CLOSED_ERROR_CODE in b4m-core/common/src/apiErrorCodes.ts.
  static let questionClosedErrorCode = "question_closed"
  static let fallbackRefusal = "Your reply could not be sent right now. Try again in a moment."
  static let fallbackDispatchFailure =
    "Reply delivery could not be confirmed. Check the conversation before sending another reply."

  struct ErrorEnvelope: Decodable {
    let errorCode: String?
    let error: String?
  }

  static func errorEnvelope(_ body: Data) -> ErrorEnvelope? {
    try? JSONDecoder().decode(ErrorEnvelope.self, from: body)
  }

  private struct ReplyBody: Encodable {
    let text: String
    let choiceIndex: Int?
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
  static let decoder: JSONDecoder = {
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
