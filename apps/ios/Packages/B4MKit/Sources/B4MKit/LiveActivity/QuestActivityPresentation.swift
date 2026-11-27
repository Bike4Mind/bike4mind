import Foundation

/// What a Live Activity says for a content state, as plain values: the words, the symbol and how urgent it
/// is. The widget extension only chooses fonts and colors, so the copy is unit-testable here.
public struct QuestActivityPresentation: Equatable, Sendable {
  public enum Tone: Equatable, Sendable {
    case active
    case attention
    case success
    case failure
    case neutral
  }

  /// Short status word: "Working", "Approval needed", "Done".
  public let statusText: String
  /// One line under the title: the stage the run is in, or a stock line for the state.
  public let detail: String
  public let symbolName: String
  public let tone: Tone
  /// An approval waits on the user and everything stops until they act: the one state drawn urgently.
  public let isUrgent: Bool
  public let isTerminal: Bool
  public let progress: Double?

  public init(_ state: QuestActivityContentState) {
    let phase = state.phase
    let label = state.stageLabel.flatMap { $0.isEmpty ? nil : $0 }
    isTerminal = phase.isTerminal
    isUrgent = phase == .approvalNeeded
    progress = phase.isTerminal ? nil : state.progressFraction
    switch phase {
    case .running:
      statusText = "Working"
      detail = label ?? "Working on it"
      symbolName = "sparkles"
      tone = .active
    case .paused:
      statusText = "Paused"
      detail = label ?? "Waiting for your input"
      symbolName = "pause.circle.fill"
      tone = .attention
    case .approvalNeeded:
      statusText = "Approval needed"
      detail = label ?? "Waiting for your approval"
      symbolName = "exclamationmark.triangle.fill"
      tone = .attention
    case .completed:
      statusText = "Done"
      detail = "Finished"
      symbolName = "checkmark.circle.fill"
      tone = .success
    case .failed:
      statusText = "Failed"
      detail = label ?? "It could not finish"
      symbolName = "exclamationmark.circle.fill"
      tone = .failure
    case .stopped:
      statusText = "Stopped"
      detail = "Stopped before it finished"
      symbolName = "stop.circle.fill"
      tone = .neutral
    }
  }
}
