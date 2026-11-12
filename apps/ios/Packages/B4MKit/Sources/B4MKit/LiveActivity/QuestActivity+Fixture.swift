import Foundation

extension QuestActivityAttributes {
  /// Attributes for previews and fixture runs.
  public static let preview = QuestActivityAttributes(
    questId: "preview-quest", sessionId: "preview-session", title: "Quarterly metrics review",
    startedAt: Date(timeIntervalSinceNow: -95))
}

extension QuestActivityContentState {
  public static let previewRunning = QuestActivityContentState(
    phase: .running, stageLabel: "Using web_search", progress: 0.4)
  public static let previewRunningNoProgress = QuestActivityContentState(
    phase: .running, stageLabel: "Reading the quarterly report")
  public static let previewApproval = QuestActivityContentState(
    phase: .approvalNeeded, stageLabel: QuestActivityMapping.approvalLabel)
  public static let previewPaused = QuestActivityContentState(
    phase: .paused, stageLabel: QuestActivityMapping.pausedLabel)
  public static let previewCompleted = QuestActivityContentState(phase: .completed)
  public static let previewFailed = QuestActivityContentState(phase: .failed, errored: true)
  public static let previewStopped = QuestActivityContentState(phase: .stopped)
}
