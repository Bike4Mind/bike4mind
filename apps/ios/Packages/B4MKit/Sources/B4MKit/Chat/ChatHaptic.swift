import Foundation

/// A status transition worth a haptic tick. The view maps each to a `SensoryFeedback`; deciding WHEN
/// lives here so it is testable.
public enum ChatHaptic: Hashable, Sendable {
  /// The reply started working.
  case started
  /// A tool is waiting on the user's approval.
  case needsAttention
  case finished
  case failed

  /// The tick (if any) for a turn moving from `old` to `new`. `old == nil` means the turn just appeared.
  public static func transition(from old: QuestTurn?, to new: QuestTurn) -> ChatHaptic? {
    let wasTerminal = old?.status?.isTerminal ?? false
    let isTerminal = new.status?.isTerminal ?? false
    if isTerminal && !wasTerminal {
      return new.isFailed ? .failed : .finished
    }
    if new.kind == .error && old?.kind != .error {
      return .failed
    }
    if new.pendingAction != nil && new.pendingAction != old?.pendingAction {
      return .needsAttention
    }
    if new.status == .running && old?.status != .running {
      return .started
    }
    return nil
  }
}

/// A haptic to play, with a sequence number so two identical ticks in a row still change the value
/// SwiftUI's `sensoryFeedback(trigger:)` watches.
public struct HapticTrigger: Hashable, Sendable {
  public let haptic: ChatHaptic
  public let sequence: Int
}
