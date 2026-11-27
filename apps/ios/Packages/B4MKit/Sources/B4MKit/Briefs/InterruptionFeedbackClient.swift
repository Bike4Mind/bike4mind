import Foundation

/// What the user taught about pushes after a busy block. Mirrors `InterruptionFeedbackSchema` in
/// `b4m-core/common/src/schemas/pushNotification.ts`: `true` holds the block-end push when everything the brief
/// reports is in quieted categories; `nil` means never set, which the server treats like `false`.
public struct InterruptionFeedback: Codable, Equatable, Sendable {
  public var agentCompleted: Bool?
  public var agentFailed: Bool?

  public init(agentCompleted: Bool? = nil, agentFailed: Bool? = nil) {
    self.agentCompleted = agentCompleted
    self.agentFailed = agentFailed
  }

  enum CodingKeys: String, CodingKey {
    case agentCompleted = "agent_completed"
    case agentFailed = "agent_failed"
  }

  public subscript(category: InterruptionCategory) -> Bool? {
    get {
      switch category {
      case .agentCompleted: agentCompleted
      case .agentFailed: agentFailed
      }
    }
    set {
      switch category {
      case .agentCompleted: agentCompleted = newValue
      case .agentFailed: agentFailed = newValue
      }
    }
  }
}

/// The run categories a user can quiet after a busy block (`INTERRUPTION_FEEDBACK_CATEGORIES` on the server).
public enum InterruptionCategory: String, CaseIterable, Identifiable, Sendable {
  case agentCompleted = "agent_completed"
  case agentFailed = "agent_failed"

  public var id: String { rawValue }
}

public protocol InterruptionFeedbackAPI: Sendable {
  func feedback() async throws -> InterruptionFeedback
  /// Sets only the categories present in `patch`; the others keep their stored value.
  func save(_ patch: InterruptionFeedback) async throws -> InterruptionFeedback
}

/// Hand-written client for `GET`/`PUT /api/v1/assistant/interruptions`, like `BusyBlocksClient`.
public struct InterruptionFeedbackClient: InterruptionFeedbackAPI {
  private let requester: AuthorizedRequester
  private static let path = "api/v1/assistant/interruptions"

  public init(baseURL: URL, tokens: any AccessTokenProviding, transport: any HTTPTransport = URLSessionTransport()) {
    requester = AuthorizedRequester(baseURL: baseURL, tokens: tokens, transport: transport)
  }

  public func feedback() async throws -> InterruptionFeedback {
    try decode(try await requester.send(method: "GET", path: Self.path))
  }

  public func save(_ patch: InterruptionFeedback) async throws -> InterruptionFeedback {
    let body = try JSONEncoder().encode(patch)
    return try decode(try await requester.send(method: "PUT", path: Self.path, jsonBody: body))
  }

  private struct Envelope: Decodable {
    let feedback: InterruptionFeedback
  }

  private func decode(_ response: AuthorizedRequester.Response) throws -> InterruptionFeedback {
    guard (200..<300).contains(response.status) else { throw APIError(status: response.status) }
    do {
      return try JSONDecoder().decode(Envelope.self, from: response.body).feedback
    } catch {
      throw APIError.malformedResponse
    }
  }
}
