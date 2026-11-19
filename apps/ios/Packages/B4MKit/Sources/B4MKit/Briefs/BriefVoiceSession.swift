import Foundation

/// The brief side of a voice conversation started from a brief: loads it and decides what voice mode reads
/// first. Holds its own BriefViewModel, so the brief screen refetches to see anything answered here.
@MainActor
public final class BriefVoiceSession {
  public static let loadFailure = "I couldn't load your brief."

  public let model: BriefViewModel

  /// A composing brief is polled once, briefly: voice mode should speak promptly, not wait out a compose.
  public init(briefID: String, api: any BriefAPI, pendingActions: (any PendingActionAPI)?) {
    model = BriefViewModel(
      api: api, briefID: briefID, pendingActions: pendingActions, pollInterval: .seconds(1),
      pollWindow: .seconds(1))
  }

  /// What voice mode says on opening, and the brief text that seeds the first chat turn (nil when the brief
  /// could not be loaded, so plain voice continues without it).
  public func prepare() async -> (opening: [String], context: String?) {
    await model.load()
    guard case .loaded = model.state, let brief = model.brief else { return ([Self.loadFailure], nil) }
    let sections = SpokenBriefRenderer.sections(for: brief)
    return (sections, sections.joined(separator: "\n"))
  }
}
