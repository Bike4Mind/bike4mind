import Foundation

/// Maps what the app already knows about a quest onto the activity's content state, the same way the
/// server maps it for remote updates (apps/client/server/queueHandlers/questProcessor.push.ts for chat
/// turns, apps/workers/src/queueHandlers/agentExecutor.push.ts for agent runs). Keeping the two in step
/// is what lets a local update and a pushed one agree about what the lock screen says.
public enum QuestActivityMapping {
  public static let approvalLabel = "Waiting for your approval"
  public static let pausedLabel = "Waiting for your input"
  static let maxStageLabelLength = 60

  /// A streamed chat frame. A terminal status wins over everything; an error turn is a failure even when
  /// the server also marked it stopped.
  public static func state(from frame: ChatQuestFrame) -> QuestActivityContentState {
    state(
      status: frame.status, kind: frame.kind, hasPendingAction: frame.pendingAction != nil,
      statusMessage: frame.statusMessage)
  }

  /// A quest as the transcript holds it (a polled snapshot, or the turn a receipt just created).
  public static func state(from turn: QuestTurn, statusMessage: String? = nil) -> QuestActivityContentState {
    state(
      status: turn.status, kind: turn.kind, hasPendingAction: turn.pendingAction != nil, statusMessage: statusMessage)
  }

  private static func state(
    status: QuestTurn.Status?, kind: QuestTurn.Kind?, hasPendingAction: Bool, statusMessage: String?
  ) -> QuestActivityContentState {
    if kind == .error { return QuestActivityContentState(phase: .failed, errored: true) }
    switch status {
    case .done: return QuestActivityContentState(phase: .completed)
    case .stopped: return QuestActivityContentState(phase: .stopped)
    case .pending, .running, nil: break
    }
    if hasPendingAction {
      return QuestActivityContentState(phase: .approvalNeeded, stageLabel: approvalLabel)
    }
    return QuestActivityContentState(phase: .running, stageLabel: stageLabel(statusMessage))
  }

  /// A run polled from `GET /api/v1/agent-executions/{id}`. The trace gives the stage label the way the
  /// worker derives it from `iteration_step` frames: "Using <tool>" while a tool runs, "Finished <tool>"
  /// once its observation arrives.
  public static func state(from run: AgentRunStatus) -> QuestActivityContentState {
    switch run.state {
    case .completed: return QuestActivityContentState(phase: .completed)
    case .failed: return QuestActivityContentState(phase: .failed, errored: true)
    case .aborted: return QuestActivityContentState(phase: .stopped)
    case .awaitingPermission: return QuestActivityContentState(phase: .approvalNeeded, stageLabel: approvalLabel)
    case .paused: return QuestActivityContentState(phase: .paused, stageLabel: pausedLabel)
    case .pending, .running, .continuing, .awaitingSubagent, .awaitingDagChildren:
      return QuestActivityContentState(phase: .running, stageLabel: stageLabel(for: run.steps))
    }
  }

  private static func stageLabel(for steps: [AgentRunStatus.Step]) -> String? {
    var lastTool: String?
    var label: String?
    for step in steps {
      switch step.type {
      case .action:
        guard let tool = step.toolName, !tool.isEmpty else { continue }
        lastTool = tool
        label = "Using \(tool)"
      case .observation:
        if let lastTool { label = "Finished \(lastTool)" }
      case .thought, .finalAnswer, .other:
        continue
      }
    }
    return stageLabel(label)
  }

  /// Trimmed and capped (a lock screen line is short); blank is no label.
  static func stageLabel(_ text: String?) -> String? {
    guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
    guard trimmed.count > maxStageLabelLength else { return trimmed }
    return String(trimmed.prefix(maxStageLabelLength - 3)) + "..."
  }
}

enum QuestActivityTitle {
  static let maxLength = 40

  /// A title for a conversation that has no name yet: the opening of what was asked.
  static func fromPrompt(_ prompt: String) -> String {
    let collapsed = prompt.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    guard !collapsed.isEmpty else { return "Bike4Mind" }
    guard collapsed.count > maxLength else { return collapsed }
    return String(collapsed.prefix(maxLength - 3)) + "..."
  }
}
