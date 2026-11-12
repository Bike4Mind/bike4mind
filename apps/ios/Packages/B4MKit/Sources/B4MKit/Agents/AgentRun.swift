import Foundation

/// The server's acknowledgement of a started agent run (`202` from `POST /api/v1/agent-executions`).
public struct AgentRunReceipt: Hashable, Sendable {
  public let executionID: String
  /// The chat-history quest holding the prompt, which gains the reply when the run completes. The server
  /// writes it best effort, so it can be absent; the run proceeds either way.
  public let questID: String?
  public let sessionID: String

  public init(executionID: String, questID: String?, sessionID: String) {
    self.executionID = executionID
    self.questID = questID
    self.sessionID = sessionID
  }

  /// What a Live Activity is keyed by: the quest the server pushes progress under, or the execution when
  /// there is no quest (the activity then only moves from local polling).
  public var trackingID: String { questID ?? executionID }
}

/// A run as `GET /api/v1/agent-executions/{id}` reports it.
public struct AgentRunStatus: Hashable, Sendable {
  /// The public status set (`PUBLIC_AGENT_EXECUTION_STATUSES`). A value this build does not know reads as
  /// `running`, so a newer server never ends an activity early.
  public enum State: String, Hashable, Sendable {
    case pending, running, continuing, paused, completed, failed, aborted
    case awaitingPermission = "awaiting_permission"
    case awaitingSubagent = "awaiting_subagent"
    case awaitingDagChildren = "awaiting_dag_children"

    public init(wire: String) {
      self = Self(rawValue: wire) ?? .running
    }

    public var isTerminal: Bool { self == .completed || self == .failed || self == .aborted }
  }

  public struct Step: Hashable, Sendable {
    public enum Kind: Hashable, Sendable {
      case thought, action, observation, finalAnswer, other
    }

    public let type: Kind
    public let toolName: String?

    public init(type: Kind, toolName: String? = nil) {
      self.type = type
      self.toolName = toolName
    }
  }

  public let id: String
  public let state: State
  public let steps: [Step]
  /// Why a `failed` run ended without an answer.
  public let error: String?

  public init(id: String, state: State, steps: [Step] = [], error: String? = nil) {
    self.id = id
    self.state = state
    self.steps = steps
    self.error = error
  }
}

/// The agent-run routes. A run is fire-and-forget: nothing streams back over REST, so progress comes from
/// polling `run(id:)` (and, for the lock screen, from the server's Live Activity pushes).
public protocol AgentRunAPI: Sendable {
  func startRun(sessionID: String, message: String) async throws -> AgentRunReceipt
  func run(id: String) async throws -> AgentRunStatus
}
