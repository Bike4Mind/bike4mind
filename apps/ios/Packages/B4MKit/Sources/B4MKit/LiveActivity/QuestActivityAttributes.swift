import Foundation

#if os(iOS)
  import ActivityKit
#endif

/// Where a quest (a chat turn or an agent run) stands, as a Live Activity shows it.
///
/// The wire values are the server's (`LiveActivityContentStateSchema`, b4m-core/common): a value this build
/// does not know is treated as `running`, so a newer server never blanks the lock screen.
public enum QuestRunPhase: String, Hashable, Sendable, CaseIterable {
  case running
  case paused
  case approvalNeeded = "approval_needed"
  case completed
  case failed
  case stopped

  public init(wire: String) {
    self = Self(rawValue: wire) ?? .running
  }

  public var isTerminal: Bool {
    switch self {
    case .completed, .failed, .stopped: true
    case .running, .paused, .approvalNeeded: false
    }
  }
}

/// The activity's `content-state`. Keys match the server payload exactly: `status`, `stageLabel`,
/// `progress` (0...1), `errored` and `pendingActionTs`. Keep in sync with `LiveActivityContentStateSchema`
/// (b4m-core/common/src/schemas/liveActivityPush.ts); ActivityKit decodes pushed states with a plain
/// `JSONDecoder`, so these property names ARE the wire format.
public struct QuestActivityContentState: Codable, Hashable, Sendable {
  /// Raw wire value. Stored as sent so an unknown status round-trips; read `phase` for the typed value.
  public var status: String
  public var stageLabel: String?
  public var progress: Double?
  public var errored: Bool?
  /// With `approval_needed`: the `ts` of the pending action shown, which the activity's buttons answer.
  public var pendingActionTs: Int64?

  public init(
    status: String, stageLabel: String? = nil, progress: Double? = nil, errored: Bool? = nil,
    pendingActionTs: Int64? = nil
  ) {
    self.status = status
    self.stageLabel = stageLabel
    self.progress = progress
    self.errored = errored
    self.pendingActionTs = pendingActionTs
  }

  public init(
    phase: QuestRunPhase, stageLabel: String? = nil, progress: Double? = nil, errored: Bool? = nil,
    pendingActionTs: Int64? = nil
  ) {
    self.init(
      status: phase.rawValue, stageLabel: stageLabel, progress: progress, errored: errored,
      pendingActionTs: pendingActionTs)
  }

  public var phase: QuestRunPhase { QuestRunPhase(wire: status) }

  /// `progress` clamped to 0...1, or `nil` when the run has no measurable total.
  public var progressFraction: Double? {
    guard let progress, progress.isFinite else { return nil }
    return min(max(progress, 0), 1)
  }
}

/// The fixed part of a quest's Live Activity. Lives in B4MKit so the app (which starts and updates the
/// activity) and the widget extension (which draws it) compile the same type.
public struct QuestActivityAttributes: Hashable, Sendable, Codable {
  public typealias ContentState = QuestActivityContentState

  public let questId: String
  public let sessionId: String
  /// The session's name, or the opening of the prompt for a brand-new conversation.
  public let title: String
  public let startedAt: Date

  public init(questId: String, sessionId: String, title: String, startedAt: Date) {
    self.questId = questId
    self.sessionId = sessionId
    self.title = title
    self.startedAt = startedAt
  }
}

extension QuestActivityAttributes {
  /// The approval the activity's approve and deny buttons answer: only while the quest waits on one and the
  /// state names its `ts`, so a button can never answer a newer action than the one on screen.
  public func approvalTarget(in state: QuestActivityContentState) -> PendingActionTarget? {
    guard state.phase == .approvalNeeded, let ts = state.pendingActionTs, ts > 0 else { return nil }
    return PendingActionTarget(questID: questId, pendingActionTs: ts)
  }
}

#if os(iOS)
  extension QuestActivityAttributes: ActivityAttributes {}
#endif
