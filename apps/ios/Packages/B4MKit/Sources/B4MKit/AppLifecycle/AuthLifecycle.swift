import Foundation

/// Decides what the app does as `AuthController.State` changes. `RootView` runs the returned plan; the
/// decisions live here so the edges are testable without SwiftUI.
///
/// App Lock flips `.signedIn` and `.locked` every time the app backgrounds, so anything that belongs to a
/// fresh launch or a fresh session must key off the session edge, not off "became signed in".
public struct AuthLifecycle: Sendable {
  public struct Plan: Equatable, Sendable {
    /// Push registration and Live Activity re-attach for a session that just began (sign-in or restore).
    public var startsSession = false
    /// Work a fresh launch or a fresh sign-in owes the shell: widget reset (no agent is known to be running
    /// yet) and the foreground refreshes `scenePhase` skipped while auth was still restoring.
    public var runsLaunchWork = false
    /// A deep link that arrived before the shell existed is applied now.
    public var releasesPendingRoute = false
    /// Account-scoped state is torn down.
    public var endsSession = false

    public init(
      startsSession: Bool = false, runsLaunchWork: Bool = false, releasesPendingRoute: Bool = false,
      endsSession: Bool = false
    ) {
      self.startsSession = startsSession
      self.runsLaunchWork = runsLaunchWork
      self.releasesPendingRoute = releasesPendingRoute
      self.endsSession = endsSession
    }
  }

  private var previous: AuthController.State
  private var owesLaunchWork = true

  public init(initial: AuthController.State = .restoring) {
    previous = initial
  }

  public mutating func transition(to state: AuthController.State) -> Plan {
    defer { previous = state }
    var plan = Plan()
    switch state {
    case .signedIn, .locked:
      plan.startsSession = !Self.hasSession(previous)
      if state == .signedIn {
        plan.releasesPendingRoute = true
        // Only the first unlock after a launch or sign-in: later unlocks must not clear a running agent.
        plan.runsLaunchWork = owesLaunchWork
        owesLaunchWork = false
      }
    case .signedOut:
      plan.endsSession = true
      owesLaunchWork = true
    case .restoring:
      owesLaunchWork = true
    }
    return plan
  }

  private static func hasSession(_ state: AuthController.State) -> Bool {
    state == .signedIn || state == .locked
  }
}
