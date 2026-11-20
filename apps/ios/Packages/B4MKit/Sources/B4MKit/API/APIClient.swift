import B4MClient
import Foundation
import OpenAPIRuntime

/// `B4MAPI` over the generated `B4MClient`: bearer injection, one 401 retry, and the mapping from
/// generated response enums to domain models and `APIError`.
public struct APIClient: B4MAPI {
  private let client: Client
  private let requester: AuthorizedRequester

  public init(
    baseURL: URL,
    tokens: any AccessTokenProviding,
    transport: any HTTPTransport = URLSessionTransport()
  ) {
    requester = AuthorizedRequester(baseURL: baseURL, tokens: tokens, transport: transport)
    client = Client(
      serverURL: baseURL,
      configuration: Configuration(dateTranscoder: LenientISO8601DateTranscoder()),
      transport: HTTPTransportAdapter(transport: transport),
      middlewares: [BearerAuthMiddleware(tokens: tokens)]
    )
  }

  public func listSessions(cursor: String?, limit: Int) async throws -> Page<SessionSummary> {
    try await call {
      let output = try await client.listSessions(query: .init(limit: limit, cursor: cursor))
      switch output {
      case .ok(let ok):
        let body = try ok.body.json
        return Page(items: body.data.map(SessionSummary.init), nextCursor: body.nextCursor)
      case .unauthorized: throw APIError.signedOut
      case .forbidden: throw APIError.forbidden
      case .tooManyRequests: throw APIError.rateLimited
      case .upgradeRequired: throw APIError.upgradeRequired
      case .undocumented(let status, _): throw APIError(status: status)
      default: throw APIError.malformedResponse
      }
    }
  }

  public func listSessionQuests(sessionID: String, cursor: String?, limit: Int) async throws -> Page<QuestTurn> {
    try await call {
      let output = try await client.listSessionQuests(
        path: .init(id: sessionID), query: .init(limit: limit, cursor: cursor))
      switch output {
      case .ok(let ok):
        let body = try ok.body.json
        return Page(items: body.data.map(QuestTurn.init), nextCursor: body.nextCursor)
      case .unauthorized: throw APIError.signedOut
      case .forbidden: throw APIError.forbidden
      case .notFound: throw APIError.notFound
      case .tooManyRequests: throw APIError.rateLimited
      case .upgradeRequired: throw APIError.upgradeRequired
      case .undocumented(let status, _): throw APIError(status: status)
      default: throw APIError.malformedResponse
      }
    }
  }

  public func creditBalance() async throws -> CreditBalance {
    try await call {
      let output = try await client.getCreditBalance()
      switch output {
      case .ok(let ok):
        return CreditBalance(credits: try ok.body.json.balance)
      case .unauthorized: throw APIError.signedOut
      case .forbidden: throw APIError.forbidden
      case .tooManyRequests: throw APIError.rateLimited
      case .upgradeRequired: throw APIError.upgradeRequired
      case .undocumented(let status, _): throw APIError(status: status)
      default: throw APIError.malformedResponse
      }
    }
  }

  public func quest(id: String) async throws -> QuestTurn {
    try await call {
      let output = try await client.getQuest(path: .init(id: id))
      switch output {
      case .ok(let ok):
        return QuestTurn(try ok.body.json)
      case .unauthorized: throw APIError.signedOut
      case .forbidden: throw APIError.forbidden
      case .notFound: throw APIError.notFound
      case .tooManyRequests: throw APIError.rateLimited
      case .upgradeRequired: throw APIError.upgradeRequired
      case .undocumented(let status, _): throw APIError(status: status)
      default: throw APIError.malformedResponse
      }
    }
  }

  public func sendChatMessage(_ request: ChatSendRequest) async throws -> ChatSendReceipt {
    let response = try await requester.send(
      method: "POST", path: "api/chat", jsonBody: try ChatSendWire.body(for: request))
    return try ChatSendWire.receipt(status: response.status, body: response.body)
  }

  /// Runs one generated call and folds every failure into `APIError`.
  private func call<Result>(_ operation: () async throws -> Result) async throws -> Result {
    do {
      return try await operation()
    } catch let error as APIError {
      throw error
    } catch let error as ClientError {
      throw Self.map(error.underlyingError)
    } catch {
      throw Self.map(error)
    }
  }

  private static func map(_ error: any Error) -> APIError {
    switch error {
    case let apiError as APIError: apiError
    case let authError as AuthError: APIError(authError)
    case let keychainError as KeychainError: APIError(keychainError)
    case is URLError: .offline
    case is DecodingError: .malformedResponse
    default: .malformedResponse
    }
  }
}

// MARK: - Generated type to domain mapping

private typealias SessionPayload = Components.Schemas.ListSessionsResponse200.DataPayloadPayload
private typealias QuestPayload = Components.Schemas.ListSessionQuestsResponse200.DataPayloadPayload

extension SessionSummary {
  fileprivate init(_ payload: SessionPayload) {
    self.init(
      id: payload.id,
      name: payload.name,
      lastUsedModel: payload.lastUsedModel,
      firstCreated: payload.firstCreated,
      lastUpdated: payload.lastUpdated
    )
  }
}

extension QuestTurn {
  fileprivate init(_ payload: QuestPayload) {
    self.init(
      id: payload.id,
      prompt: payload.prompt,
      reply: payload.reply,
      status: payload.status.flatMap(Status.init(rawValue:)),
      kind: payload._type.flatMap(Kind.init(rawValue:)),
      errorCode: payload.errorCode.flatMap(ErrorCode.init(rawValue:)),
      createdAt: payload.createdAt,
      creditsUsed: payload.creditsUsed,
      pendingAction: payload.pendingAction.map(PendingAction.init)
    )
  }
}

extension QuestTurn {
  fileprivate init(_ payload: Components.Schemas.GetQuestResponse200) {
    self.init(
      id: payload.id,
      prompt: nil,
      reply: payload.reply,
      status: payload.status.flatMap(Status.init(rawValue:)),
      kind: payload._type.flatMap(Kind.init(rawValue:)),
      errorCode: payload.errorCode.flatMap(ErrorCode.init(rawValue:)),
      createdAt: payload.createdAt ?? Date()
    )
  }
}

extension PendingAction {
  fileprivate init(_ payload: QuestPayload.PendingActionPayload) {
    self.init(
      tool: payload.tool,
      parameters: payload.params.additionalProperties.mapValues(Self.displayText),
      requestedAt: Date(timeIntervalSince1970: payload.ts / 1000)
    )
  }

  /// A tool argument as the user should read it: strings verbatim, scalars plainly, objects and
  /// arrays as compact JSON (never Swift's `Optional(...)`/`AnyHashable(...)` debug rendering).
  fileprivate static func displayText(_ container: OpenAPIValueContainer) -> String {
    switch container.value {
    case nil: return ""
    case let string as String: return string
    case let bool as Bool: return bool ? "true" : "false"
    case let int as Int: return String(int)
    case let double as Double: return String(double)
    default:
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
      guard let data = try? encoder.encode(container) else { return "" }
      return String(decoding: data, as: UTF8.self)
    }
  }
}
