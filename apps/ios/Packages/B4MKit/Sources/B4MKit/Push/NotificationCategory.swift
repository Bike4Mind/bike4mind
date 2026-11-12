import Foundation

/// Push categories the server sends (and the `userSettings.pushNotifications` keys).
public enum NotificationCategory: String, CaseIterable, Sendable, Codable, Identifiable {
  case agentCompleted = "agent_completed"
  case agentFailed = "agent_failed"
  case approvalNeeded = "approval_needed"
  case chatCompleted = "chat_completed"
  case generationReady = "generation_ready"
  case agentMessage = "agent_message"

  public var id: String { rawValue }

  public var title: String {
    switch self {
    case .agentCompleted: "Agent finished"
    case .agentFailed: "Agent hit a problem"
    case .approvalNeeded: "Needs your approval"
    case .chatCompleted: "Replies ready"
    case .generationReady: "Creations ready"
    case .agentMessage: "Agent messages"
    }
  }

  /// Product-voice explanation shown under the toggle.
  public var detail: String {
    switch self {
    case .agentCompleted: "Hear when an agent wraps up the job you gave it."
    case .agentFailed: "Know right away when a run stops so you can step in."
    case .approvalNeeded: "An agent is waiting on your go-ahead before it continues."
    case .chatCompleted: "A long answer finished while you were away."
    case .generationReady: "Your image, video or music is done and waiting."
    case .agentMessage: "Your agent has something to tell you."
    }
  }
}
