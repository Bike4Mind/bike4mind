import Foundation
import Observation

/// App-wide navigation state that routes mutate: which tab is selected and what is pushed on the
/// Sessions stack. Lives in B4MKit so route handling is testable without SwiftUI.
@MainActor
@Observable
public final class AppNavigator {
  public var selectedTab: AppTab = .sessions
  public var sessionPath: [SessionSummary] = []
  /// The composer an App Intent asked for. A new-conversation request is shown as a sheet until
  /// `dismissNewConversation()`; a session request is taken by that session's screen via `takeComposeRequest`.
  public private(set) var composeRequest: ComposeRequest?
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
      // A deep link carries only the id; the detail screen loads the transcript and looks the name up.
      if sessionPath.last?.id != id { sessionPath = [.placeholder(id: id)] }
    case .sessions:
      sessionPath = []
    case .compose(let request):
      composeRequest = request
      if case .session(let id) = request.target, sessionPath.last?.id != id {
        sessionPath = [.placeholder(id: id, name: request.sessionName)]
      }
    case .lakes, .media, .settings:
      break
    case .lake(let id):
      externalURL = Self.webURL(forLake: id)
    case .web(let url):
      externalURL = url
    }
  }

  /// The pending new-conversation request, if that is what an intent asked for.
  public var newConversationRequest: ComposeRequest? {
    guard let composeRequest, composeRequest.target == .newConversation else { return nil }
    return composeRequest
  }

  public func dismissNewConversation() {
    if newConversationRequest != nil { composeRequest = nil }
  }

  /// Hands the draft for `sessionID` to its screen exactly once.
  public func takeComposeRequest(forSession sessionID: String) -> ComposeRequest? {
    guard let composeRequest, composeRequest.target == .session(id: sessionID) else { return nil }
    self.composeRequest = nil
    return composeRequest
  }

  /// Same shape as the universal link `DeepLinkRouter` reads, so the web app resolves it the same way.
  static func webURL(forLake id: String) -> URL? {
    guard DeepLinkRouter.isValidIdentifier(id) else { return nil }
    return URL(string: "https://\(DeepLinkRouter.appHost)/lakes/\(id)")
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
    case .lake, .web, .compose: return false
    }
  }
}

extension SessionSummary {
  /// Stand-in used when only an id is known (deep links). The detail screen needs just the id and looks up
  /// an empty name (see `SessionLookup.name`).
  static func placeholder(id: String, name: String = "") -> SessionSummary {
    SessionSummary(id: id, name: name, lastUsedModel: nil, firstCreated: .distantPast, lastUpdated: .distantPast)
  }
}
