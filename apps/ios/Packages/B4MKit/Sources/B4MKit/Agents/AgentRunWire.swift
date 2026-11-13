import Foundation

/// Hand-written wire format for `POST /api/v1/agent-executions` (operationId `startAgentExecution`) and
/// `GET /api/v1/agent-executions/{id}` (`getAgentExecution`); contract
/// b4m-core/common/src/api-contract/contracts/agentExecutions.contract.ts, schemas in
/// b4m-core/common/src/schemas/agentExecution.ts.
///
/// Hand-written like `ChatSendWire`: the app sends two fields and reads a handful, so a focused pair is
/// smaller than regenerating the client for it. Keep it in sync with the contract when either side changes.
///
/// REST runs have no interactive client: a tool that needs approval fails the run instead of pausing it
/// (see the contract), so the app never has to answer an approval for a run it started.
enum AgentRunWire {
  static let path = "api/v1/agent-executions"

  struct StartBody: Encodable, Equatable {
    let sessionID: String
    let message: String

    enum CodingKeys: String, CodingKey {
      case sessionID = "session_id"
      case message
    }
  }

  static func startBody(sessionID: String, message: String) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    return try encoder.encode(StartBody(sessionID: sessionID, message: message))
  }

  static func statusPath(id: String) throws -> String {
    guard !id.isEmpty, id.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else {
      throw APIError.notFound
    }
    return "\(path)/\(id)"
  }

  private struct Ack: Decodable {
    struct Tracking: Decodable {
      let executionID: String?
      let questID: String?

      enum CodingKeys: String, CodingKey {
        case executionID = "execution_id"
        case questID = "quest_id"
      }
    }

    let id: String?
    let sessionID: String?
    let tracking: Tracking?

    enum CodingKeys: String, CodingKey {
      case id
      case sessionID = "session_id"
      case tracking = "tracking_info"
    }
  }

  static func receipt(status: Int, body: Data, sessionID: String) throws -> AgentRunReceipt {
    guard status == 202 || status == 200 else { throw APIError(status: status) }
    guard let ack = try? JSONDecoder().decode(Ack.self, from: body),
      let executionID = ack.tracking?.executionID ?? ack.id
    else { throw APIError.malformedResponse }
    let questID = ack.tracking?.questID.flatMap { $0.isEmpty ? nil : $0 }
    return AgentRunReceipt(executionID: executionID, questID: questID, sessionID: ack.sessionID ?? sessionID)
  }

  private struct StatusBody: Decodable {
    struct Step: Decodable {
      let type: String?
      let toolName: String?

      enum CodingKeys: String, CodingKey {
        case type
        case toolName = "tool_name"
      }
    }

    let id: String?
    let status: String?
    let error: String?
    let steps: [Step]?
  }

  static func status(status: Int, body: Data) throws -> AgentRunStatus {
    guard status == 200 else { throw APIError(status: status) }
    guard let decoded = try? JSONDecoder().decode(StatusBody.self, from: body), let id = decoded.id,
      let wireStatus = decoded.status
    else { throw APIError.malformedResponse }
    let steps = (decoded.steps ?? []).map {
      AgentRunStatus.Step(type: stepKind($0.type), toolName: $0.toolName)
    }
    return AgentRunStatus(id: id, state: AgentRunStatus.State(wire: wireStatus), steps: steps, error: decoded.error)
  }

  private static func stepKind(_ wire: String?) -> AgentRunStatus.Step.Kind {
    switch wire {
    case "thought": .thought
    case "action": .action
    case "observation": .observation
    case "final_answer": .finalAnswer
    default: .other
    }
  }
}

public struct AgentRunClient: AgentRunAPI {
  private let requester: AuthorizedRequester

  public init(baseURL: URL, tokens: any AccessTokenProviding, transport: any HTTPTransport = URLSessionTransport()) {
    requester = AuthorizedRequester(baseURL: baseURL, tokens: tokens, transport: transport)
  }

  public func startRun(sessionID: String, message: String) async throws -> AgentRunReceipt {
    let response = try await requester.send(
      method: "POST", path: AgentRunWire.path,
      jsonBody: try AgentRunWire.startBody(sessionID: sessionID, message: message))
    return try AgentRunWire.receipt(status: response.status, body: response.body, sessionID: sessionID)
  }

  public func run(id: String) async throws -> AgentRunStatus {
    let response = try await requester.send(method: "GET", path: try AgentRunWire.statusPath(id: id))
    return try AgentRunWire.status(status: response.status, body: response.body)
  }
}
