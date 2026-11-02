import Foundation
import Observation

/// App-wide navigation state that routes mutate: which tab is selected and what is pushed on the
/// Sessions stack. Lives in B4MKit so route handling is testable without SwiftUI.
@MainActor
@Observable
public final class AppNavigator {
  public var selectedTab: AppTab = .sessions
  public var sessionPath: [SessionSummary] = []
  /// A Safari fallback the view layer should open, then clear with `consumeExternalURL()`.
  public private(set) var externalURL: URL?

  /// A route that arrived before the user was signed in (cold-start notification tap). Applied by
  /// `releasePendingRoute()` once the shell is on screen.
  @ObservationIgnored private var pendingRoute: Route?

  public init() {}

  /// Queues the route until the signed-in shell exists, then applies it.
  public func open(_ route: Route, isShellReady: Bool) {
    guard isShellReady else {
      pendingRoute = route
      return
    }
    apply(route)
  }

  public func releasePendingRoute() {
    guard let route = pendingRoute else { return }
    pendingRoute = nil
    apply(route)
  }

  public func discardPendingRoute() {
    pendingRoute = nil
  }

  public func apply(_ route: Route) {
    if let tab = route.tab { selectedTab = tab }
    switch route {
    case .session(let id):
      // A deep link carries only the id; the detail screen loads the transcript by id and the title
      // fills in from the list when the user next visits it.
      if sessionPath.last?.id != id { sessionPath = [.placeholder(id: id)] }
    case .sessions:
      sessionPath = []
    case .lakes, .lake, .media, .settings:
      break
    case .web(let url):
      externalURL = url
    }
  }

  public func consumeExternalURL() {
    externalURL = nil
  }

  /// Whether the screen for `route` is what the user is looking at right now. Drives the foreground
  /// notification policy.
  public func isShowing(_ route: Route) -> Bool {
    guard let tab = route.tab, tab == selectedTab else { return false }
    switch route {
    case .session(let id): return sessionPath.last?.id == id
    case .sessions: return sessionPath.isEmpty
    case .lakes, .media, .settings: return true
    case .lake, .web: return false
    }
  }
}

extension SessionSummary {
  /// Stand-in used when only an id is known (deep links). The detail screen needs just the id.
  static func placeholder(id: String) -> SessionSummary {
    SessionSummary(id: id, name: "", lastUsedModel: nil, firstCreated: .distantPast, lastUpdated: .distantPast)
  }
}
