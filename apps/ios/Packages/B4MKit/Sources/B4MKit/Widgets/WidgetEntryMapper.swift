import Foundation

/// How a running-agents widget should render.
public enum RunningAgentsDisplay: Equatable, Sendable {
  /// Nothing was ever written (first launch, signed out, container unavailable).
  case placeholder
  /// The last observation is too old to claim anything is still running.
  case stale(observedAt: Date)
  case idle
  case active(count: Int, topTitle: String, topStatus: String, sessionID: String?)
}

public enum CreditsDisplay: Equatable, Sendable {
  case placeholder
  /// `isStale`: the balance is old enough that the widget should say so rather than imply it is current.
  case balance(formatted: String, value: Double, isStale: Bool)
}

public enum LatestGenerationDisplay: Equatable, Sendable {
  case placeholder
  case image(mediaID: String, title: String, thumbnailFileName: String?, createdAt: Date)
}

/// Pure mapping from the shared snapshot to what each widget draws. The extension's timeline providers
/// are one-liners over this, which is what makes the staleness rules testable without WidgetKit.
public struct WidgetEntryMapper: Sendable {
  /// A running-agents observation older than this is not trusted: the app only writes it while open.
  public static let runningAgentsFreshness: TimeInterval = 15 * 60
  /// A balance older than this is shown, but flagged.
  public static let creditsFreshness: TimeInterval = 24 * 60 * 60

  private let snapshot: WidgetSnapshot?
  private let now: Date
  private let locale: Locale

  public init(snapshot: WidgetSnapshot?, now: Date, locale: Locale = .current) {
    self.snapshot = snapshot
    self.now = now
    self.locale = locale
  }

  public func runningAgents() -> RunningAgentsDisplay {
    guard let running = snapshot?.runningAgents else { return .placeholder }
    guard now.timeIntervalSince(running.observedAt) <= Self.runningAgentsFreshness else {
      return .stale(observedAt: running.observedAt)
    }
    guard running.count > 0, let top = running.top else { return .idle }
    return .active(
      count: running.count, topTitle: Self.displayTitle(top.title), topStatus: Self.statusLabel(top.status),
      sessionID: top.sessionID)
  }

  public func credits() -> CreditsDisplay {
    guard let credits = snapshot?.credits else { return .placeholder }
    return .balance(
      formatted: CreditsFormat.whole(credits.balance, locale: locale), value: credits.balance,
      isStale: now.timeIntervalSince(credits.observedAt) > Self.creditsFreshness)
  }

  public func latestGeneration() -> LatestGenerationDisplay {
    guard let latest = snapshot?.latestGeneration else { return .placeholder }
    return .image(
      mediaID: latest.mediaID, title: latest.title, thumbnailFileName: latest.thumbnailFileName,
      createdAt: latest.createdAt)
  }

  /// When the widget should ask for a new timeline: right when running data would go stale, otherwise hourly.
  public func nextRefresh() -> Date {
    let hourly = now.addingTimeInterval(60 * 60)
    guard let observed = snapshot?.runningAgents?.observedAt else { return hourly }
    let staleAt = observed.addingTimeInterval(Self.runningAgentsFreshness + 1)
    return staleAt > now ? min(staleAt, hourly) : hourly
  }

  static func statusLabel(_ raw: String) -> String {
    switch raw {
    case "running": "Working"
    case "pending": "Queued"
    case "approval": "Needs approval"
    default: "Working"
    }
  }

  static func displayTitle(_ title: String) -> String {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? "Untitled" : trimmed
  }
}

/// Number formatting shared by the Settings row and the widgets.
public enum CreditsFormat {
  /// Whole credits with grouping ("31,667"); fractions are noise at this scale.
  public static func whole(_ credits: Double, locale: Locale = .current) -> String {
    credits.formatted(.number.precision(.fractionLength(0)).locale(locale))
  }

  /// A short form for tight spaces ("31.7K").
  public static func compact(_ credits: Double, locale: Locale = .current) -> String {
    credits.formatted(.number.notation(.compactName).precision(.fractionLength(0...1)).locale(locale))
  }
}
