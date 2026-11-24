import Foundation

/// How many decisions wait on the user, as the server counts them: open agent approvals in their notebooks plus
/// the other decisions of their latest ready brief, each counted once.
public struct PendingDecisionCount: Equatable, Sendable, Decodable {
  public let count: Int
  public let approvals: Int
  public let briefDecisions: Int
  /// The latest ready brief `briefDecisions` comes from.
  public let briefID: String?

  public init(count: Int, approvals: Int, briefDecisions: Int, briefID: String?) {
    self.count = count
    self.approvals = approvals
    self.briefDecisions = briefDecisions
    self.briefID = briefID
  }

  private enum CodingKeys: String, CodingKey {
    case count, approvals, briefDecisions
    case briefID = "briefId"
  }
}

public protocol PendingDecisionAPI: Sendable {
  func pendingDecisionCount() async throws -> PendingDecisionCount
}

/// Hand-written client for `GET /api/v1/pending-decisions` (JWT bearer).
public struct PendingDecisionClient: PendingDecisionAPI {
  private let requester: AuthorizedRequester

  public init(baseURL: URL, tokens: any AccessTokenProviding, transport: any HTTPTransport = URLSessionTransport()) {
    requester = AuthorizedRequester(baseURL: baseURL, tokens: tokens, transport: transport)
  }

  public func pendingDecisionCount() async throws -> PendingDecisionCount {
    let response = try await requester.send(method: "GET", path: "api/v1/pending-decisions")
    guard (200..<300).contains(response.status) else { throw APIError(status: response.status) }
    do {
      return try JSONDecoder().decode(PendingDecisionCount.self, from: response.body)
    } catch {
      throw APIError.malformedResponse
    }
  }
}
