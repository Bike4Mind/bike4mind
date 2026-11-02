import B4MKit
import SwiftUI

/// Routes between sign-in, the locked screen and the signed-in shell purely from `AuthController.state`.
struct RootView: View {
  @Environment(AuthController.self) private var auth
  @Environment(AppServices.self) private var services
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    Group {
      switch auth.state {
      case .restoring:
        ProgressView()
          .task { auth.restore() }
      case .signedOut(let reason):
        SignInView(signOutReason: reason)
      case .signedIn:
        MainTabView()
          .task { await services.realtime.start() }
      case .locked:
        LockedView()
      }
    }
    .animation(.default, value: auth.state)
    .onChange(of: auth.state) { _, state in
      handleAuthState(state)
    }
    .onChange(of: scenePhase, initial: true) { _, phase in
      // Lock on the way out so the app-switcher snapshot never shows content.
      if phase == .background { auth.lockIfNeeded() }
      guard phase == .active else { return }
      Task { await services.push.appDidBecomeActive() }
      services.resumeCapture()
      // A socket that gave up reconnecting while backgrounded gets a fresh start.
      if auth.state == .signedIn {
        let realtime = services.realtime
        Task { await realtime.resume() }
      }
    }
  }

  private func handleAuthState(_ state: AuthController.State) {
    switch state {
    case .signedIn, .locked:
      // First sign-in (or a restored launch) is the moment to ask for quiet push authorization.
      Task { await services.push.sessionDidStart() }
      if state == .signedIn { services.navigator.releasePendingRoute() }
    case .signedOut:
      // Cached rows belong to the account that fetched them.
      let realtime = services.realtime
      Task { await realtime.stop() }
      Task { await services.sessionListCache.clear() }
      services.push.sessionDidEnd()
      services.navigator.discardPendingRoute()
    case .restoring:
      break
    }
  }
}
